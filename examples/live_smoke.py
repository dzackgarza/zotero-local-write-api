#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "httpx>=0.28,<1",
#     "pydantic>=2.7,<3",
# ]
# ///
"""
Live smoke proof for the local-write-api add-on.

This script exercises the add-on against a real running Zotero instance:
- version probe
- every state of the /write bearer gate: open, gated, and published without a token
- create_item
- import_bibtex
- byte-backed PDF attach
- standalone PDF attach into the selected collection and the library root
- delete_tag
- trash_item

It uses only the add-on and Zotero's built-in local API. No client repo code,
no mocks, and no release tagging.
"""

from __future__ import annotations

import argparse
import base64
import json
import secrets
import sys
import time
import urllib.parse
from collections.abc import Generator
from pathlib import Path
from typing import Final, Generic, Literal, NamedTuple, NotRequired, TypeVar
from uuid import uuid4

import httpx
from pydantic import JsonValue, TypeAdapter, ValidationError
from typing_extensions import TypedDict

TOKEN_PREF: Final = "extensions.zotero.localWriteAPI.token"
PUBLIC_BASE_URL_PREF: Final = "extensions.zotero.localWriteAPI.publicBaseURL"
# How long Zotero holds each gate state before it restores the prior prefs.
GATE_HOLD_SECONDS: Final = 3


PDF_BYTES = (
    b"%PDF-1.4\n"
    b"%live-smoke-proof\n"
    b"1 0 obj\n<<>>\nendobj\n"
    b"trailer\n<<>>\n%%EOF\n"
)

# A BibTeX record whose __UID__ placeholder takes the run's suffix.
BIBTEX_RECORD: Final = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "uid-record.bib"

JsonObject = dict[str, JsonValue]
ResultT = TypeVar("ResultT")

# The book create_item stores, beside the run's own title.
BOOK_FIELDS: Final[JsonObject] = {
    "creators": [{"creatorType": "author", "firstName": "Local", "lastName": "Smoke"}],
    "date": "2026",
    "publisher": "Local Write API Smoke",
}


class SmokeFailure(RuntimeError):
    """Raised when the live smoke proof fails."""


# Response shapes from openapi.yaml, limited to the fields this proof reads.
# Validation rejects a response whose read fields are missing or mistyped, and
# `success: true` is part of every shape.


class Endpoints(TypedDict):
    attach: str
    write: str


class VersionResponse(TypedDict):
    success: Literal[True]
    version: str
    endpoints: Endpoints
    capabilities: list[str]
    translators_ready: bool


class Ack(TypedDict):
    success: Literal[True]


class ItemKeySuccess(Ack):
    item_key: str


class NoteSuccess(Ack):
    note_key: str


class CopySuccess(Ack):
    new_item_key: str


class CollectionDetails(TypedDict):
    collection_key: str


class CollectionSuccess(Ack):
    details: CollectionDetails


class AddedTagsDetails(TypedDict):
    added_tags: list[str]


class AddedTagsSuccess(Ack):
    details: AddedTagsDetails


class ErrorStatus(TypedDict):
    success: Literal[False]
    error: str


# openapi.yaml gives the /attach details two nullable keys. Together they name
# one of three placements, and each proof step expects one placement, so each
# placement is its own total shape with its own validator.


class ChildAttachDetails(TypedDict):
    """The request named item_key: the attachment is a child of that item."""

    parent_item_key: str
    collection_key: None
    source_mode: Literal["path", "bytes"]


class CollectionAttachDetails(TypedDict):
    """No item_key, and the pane selected a collection: standalone in that collection."""

    parent_item_key: None
    collection_key: str
    source_mode: Literal["path", "bytes"]


class RootAttachDetails(TypedDict):
    """No item_key, and the pane selected no collection: standalone in the library root."""

    parent_item_key: None
    collection_key: None
    source_mode: Literal["path", "bytes"]


class ChildAttachSuccess(Ack):
    attachment_key: str
    details: ChildAttachDetails


class CollectionAttachSuccess(Ack):
    attachment_key: str
    details: CollectionAttachDetails


class RootAttachSuccess(Ack):
    attachment_key: str
    details: RootAttachDetails


class JavascriptDetails(TypedDict, Generic[ResultT]):
    result: ResultT


class JavascriptSuccess(Ack, Generic[ResultT]):
    details: JavascriptDetails[ResultT]


# Item JSON from Zotero's local API (Zotero.Item.toJSON), limited to the fields
# this proof reads.


class Tag(TypedDict):
    tag: str
    # Zotero writes `type` only for an automatic tag (type 1).
    type: NotRequired[int]


class ChildItemData(TypedDict):
    itemType: str
    title: str
    tags: list[Tag]
    # Zotero writes `deleted` only for a trashed item.
    deleted: NotRequired[bool]
    # Zotero writes `parentItem` only for a child item.
    parentItem: NotRequired[str]
    # Zotero writes `contentType` only for an attachment.
    contentType: NotRequired[str]


class ItemData(ChildItemData):
    """A top-level item: Zotero writes `collections` only for these."""

    collections: list[str]


class ChildItem(TypedDict):
    key: str
    data: ChildItemData


class Item(TypedDict):
    key: str
    data: ItemData


class SmokeReport(TypedDict):
    success: Literal[True]
    version: str
    item_key: str
    bibtex_item_key: str
    attachment_key: str
    deleted_tag: str
    kept_tag: str
    standalone_attachment_keys: list[str]


# The two prefs that select the bearer gate's state; None is an unset pref.
GatePrefs = TypedDict(
    "GatePrefs",
    {
        "extensions.zotero.localWriteAPI.token": str | None,
        "extensions.zotero.localWriteAPI.publicBaseURL": str | None,
    },
)


class GateState(NamedTuple):
    """One state of the gate: the prefs that select it, and the /write status of an
    empty body sent with no bearer, a wrong bearer, and the probe bearer. The gate runs
    before body validation, so 400 means the gate let the request through."""

    name: str
    prefs: GatePrefs
    statuses: tuple[int, int, int]


class BearerAuth(httpx.Auth):
    """Sends the operator's token on every request that does not override `auth`.

    Follows the custom scheme pattern in httpx's documentation:
    https://www.python-httpx.org/advanced/authentication/#custom-authentication-schemes
    """

    def __init__(self, token: str) -> None:
        self._header = f"Bearer {token}"

    def auth_flow(self, request: httpx.Request) -> Generator[httpx.Request, httpx.Response, None]:
        request.headers["Authorization"] = self._header
        yield request


class SmokeArgs(argparse.Namespace):
    """Typed view of the parsed command line; parse_args() fills every attribute."""

    base_url: str
    library_id: str
    expected_version: str
    # The open state (no token pref, the add-on's documented loopback default) has no
    # credential: httpx.Auth() is the base scheme, which sends each request unchanged.
    token: httpx.Auth


ACK = TypeAdapter(Ack)
ITEM_KEY = TypeAdapter(ItemKeySuccess)
NOTE = TypeAdapter(NoteSuccess)
COPY = TypeAdapter(CopySuccess)
COLLECTION = TypeAdapter(CollectionSuccess)
ADDED_TAGS = TypeAdapter(AddedTagsSuccess)
ERROR = TypeAdapter(ErrorStatus)
CHILD_ATTACH = TypeAdapter(ChildAttachSuccess)
COLLECTION_ATTACH = TypeAdapter(CollectionAttachSuccess)
ROOT_ATTACH = TypeAdapter(RootAttachSuccess)
VERSION = TypeAdapter(VersionResponse)
ITEM = TypeAdapter(Item)
CHILDREN = TypeAdapter(list[ChildItem])
JS_TEXT = TypeAdapter(JavascriptSuccess[str])
JS_INT = TypeAdapter(JavascriptSuccess[int])
JS_TRUE = TypeAdapter(JavascriptSuccess[Literal[True]])
JS_GATE_PREFS = TypeAdapter(JavascriptSuccess[GatePrefs])
JS_MERGE_STATE = TypeAdapter(JavascriptSuccess[tuple[bool, str]])

_READ_GATE_PREFS = (
    f"return Object.fromEntries({json.dumps([TOKEN_PREF, PUBLIC_BASE_URL_PREF])}"
    ".map((name) => [name, Zotero.Prefs.get(name, true) ?? null]));"
)


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise SmokeFailure(message)


def _require_ok(response: httpx.Response) -> None:
    request = response.request
    _require(
        response.is_success,
        f"{request.method} {request.url} returned HTTP {response.status_code}: {response.text}",
    )


def _get(http: httpx.Client, path: str, schema: TypeAdapter[ResultT]) -> ResultT:
    response = http.get(path)
    _require_ok(response)
    return schema.validate_json(response.content)


def _post_write(
    http: httpx.Client, path: str, payload: JsonObject, schema: TypeAdapter[ResultT]
) -> ResultT:
    """POST with the operator's credential, which the client sends on every request."""
    response = http.post(path, json=payload)
    _require_ok(response)
    return schema.validate_json(response.content)


def _prove_openapi_endpoint(http: httpx.Client, write_path: str) -> None:
    """GET /openapi.yaml serves the bundled schema as a public document."""
    response = http.get("/openapi.yaml")
    body = response.text
    _require(
        response.status_code == 200,
        f"/openapi.yaml returned HTTP {response.status_code}, expected 200: {body[:200]!r}",
    )
    _require(body.startswith("openapi:"), f"/openapi.yaml body is not an OpenAPI doc: {body[:80]!r}")
    _require(
        f"{write_path}:" in body,
        f"/openapi.yaml does not describe the {write_path} path: {body[:200]!r}",
    )


def _run_javascript(
    http: httpx.Client,
    write_path: str,
    code: str,
    schema: TypeAdapter[JavascriptSuccess[ResultT]],
) -> ResultT:
    payload: JsonObject = {"operation": "run_javascript", "code": code}
    return _post_write(http, write_path, payload, schema)["details"]["result"]


def _hold_gate_prefs(http: httpx.Client, write_path: str, prefs: GatePrefs) -> GatePrefs:
    """Set the gate prefs and return their prior values.

    Zotero itself restores the prior values after GATE_HOLD_SECONDS, so the restore
    runs when this script dies, and when the held state refuses every request,
    including the run_javascript that could undo it.
    """
    code = (
        f"let target = {json.dumps(prefs)};\n"
        "let original = Object.fromEntries(Object.keys(target)"
        ".map((name) => [name, Zotero.Prefs.get(name, true) ?? null]));\n"
        "let apply = (values) => Object.entries(values).forEach(([name, value]) =>"
        " value === null ? Zotero.Prefs.clear(name, true) : Zotero.Prefs.set(name, value, true));\n"
        "apply(target);\n"
        f"Zotero.Promise.delay({GATE_HOLD_SECONDS * 1000}).then(() => apply(original));\n"
        "return original;"
    )
    return _run_javascript(http, write_path, code, JS_GATE_PREFS)


def _write_statuses(http: httpx.Client, write_path: str, probe_token: str) -> tuple[int, int, int]:
    """/write statuses of an empty body with no bearer, a wrong bearer, and the probe bearer."""
    # httpx.Auth() is the base scheme, which sends the request unchanged: these probes
    # carry only their own header, never the operator's credential.
    no_bearer, wrong, probe = (
        http.post(write_path, json={}, headers=headers, auth=httpx.Auth()).status_code
        for headers in ({}, {"Authorization": "Bearer not-the-token"}, {"Authorization": f"Bearer {probe_token}"})
    )
    return (no_bearer, wrong, probe)


def _gate_states(probe_token: str) -> tuple[GateState, ...]:
    """The three states of bearerAuthFailure in src/auth.ts."""
    return (
        GateState("open", {TOKEN_PREF: None, PUBLIC_BASE_URL_PREF: None}, (400, 400, 400)),
        GateState("gated", {TOKEN_PREF: probe_token, PUBLIC_BASE_URL_PREF: None}, (401, 401, 400)),
        GateState(
            "denied", {TOKEN_PREF: None, PUBLIC_BASE_URL_PREF: "https://live-smoke.invalid"}, (401, 401, 401)
        ),
    )


def _prove_gate_state(http: httpx.Client, write_path: str, state: GateState, probe_token: str) -> None:
    """Hold one gate state, require its /write statuses, then require Zotero's restore."""
    original = _hold_gate_prefs(http, write_path, state.prefs)
    statuses = _write_statuses(http, write_path, probe_token)
    _require(
        statuses == state.statuses,
        f"gate state {state.name} {state.prefs!r}: /write gave {statuses} for no, wrong and probe "
        f"bearer, expected {state.statuses}",
    )
    time.sleep(GATE_HOLD_SECONDS + 1)
    restored = _run_javascript(http, write_path, _READ_GATE_PREFS, JS_GATE_PREFS)
    _require(restored == original, f"gate prefs not restored after {state.name}: {restored!r}, expected {original!r}")


def _prove_bearer_gate(http: httpx.Client, write_path: str) -> None:
    """Prove every state of the bearer gate, whatever state the instance is found in.

    The open state accepts unauthenticated writes, so the proof refuses a published
    instance: holding that state would expose run_javascript through the tunnel.
    """
    found = _run_javascript(http, write_path, _READ_GATE_PREFS, JS_GATE_PREFS)
    _require(
        found[PUBLIC_BASE_URL_PREF] in (None, ""),
        f"publicBaseURL is {found[PUBLIC_BASE_URL_PREF]!r}, so this instance is published and the "
        "open gate state would expose it. Stop the tunnel and clear publicBaseURL, then run again.",
    )
    probe_token = secrets.token_hex(16)
    # Zotero keeps a held state if it quits during the hold. The operator then
    # resets both prefs in the Config Editor, or sends this bearer.
    print(f"live-smoke: gate probe bearer {probe_token}", file=sys.stderr)
    for state in _gate_states(probe_token):
        _prove_gate_state(http, write_path, state, probe_token)


def _tag_names(item: Item) -> list[str]:
    return [
        tag["tag"].strip()
        for tag in item["data"]["tags"]
        if tag["tag"].strip()
    ]


def _get_item(http: httpx.Client, library_id: str, item_key: str) -> Item:
    quoted_key = urllib.parse.quote(item_key)
    return _get(http, f"/api/users/{library_id}/items/{quoted_key}", ITEM)


def _get_children(http: httpx.Client, library_id: str, item_key: str) -> list[ChildItem]:
    quoted_key = urllib.parse.quote(item_key)
    return _get(http, f"/api/users/{library_id}/items/{quoted_key}/children", CHILDREN)


def _wait_for_deleted(http: httpx.Client, library_id: str, item_key: str, *, timeout: float = 5.0, interval: float = 0.25) -> Item:
    deadline = time.monotonic() + timeout
    while True:
        item = _get_item(http, library_id, item_key)
        if item["data"].get("deleted") is True:
            return item
        if time.monotonic() >= deadline:
            return item
        time.sleep(interval)


def _trash_created(http: httpx.Client, write_path: str, created: list[str]) -> None:
    """Trash every top-level item this run created. Trashing is idempotent, so
    items the run already trashed or merged away are trashed again harmlessly."""
    for item_key in created:
        _post_write(http, write_path, {"operation": "trash_item", "item_key": item_key}, ACK)


def _select_pane_row(http: httpx.Client, write_path: str, row_id: str) -> None:
    """Select a row of Zotero's collection pane by its tree-row id ("L1", "C42", ...)."""
    _run_javascript(
        http,
        write_path,
        f"await Zotero.getActiveZoteroPane().collectionsView.selectByID({row_id!r}); return true;",
        JS_TRUE,
    )


def _pdf_upload(title: str, file_name: str) -> JsonObject:
    """The /attach body fields that upload PDF_BYTES inline."""
    return {
        "title": title,
        "file_name": file_name,
        "file_bytes_base64": base64.b64encode(PDF_BYTES).decode("ascii"),
    }


def _store_standalone_pdf(
    http: httpx.Client, attach_path: str, title: str, placement: TypeAdapter[ResultT]
) -> ResultT:
    """POST a parentless PDF; `placement` rejects a response for any other placement."""
    return _post_write(http, attach_path, _pdf_upload(title, "live-smoke-standalone.pdf"), placement)


def _require_stored_standalone(
    http: httpx.Client, library_id: str, attachment_key: str, title: str, expected_collections: list[str]
) -> None:
    stored = _get_item(http, library_id, attachment_key)["data"]
    _require(stored["itemType"] == "attachment", f"standalone item is not an attachment: {stored!r}")
    _require("parentItem" not in stored, f"standalone attachment has a parent: {stored!r}")
    _require(stored.get("contentType") == "application/pdf", f"standalone contentType mismatch: {stored!r}")
    _require(stored["title"] == title, f"standalone title mismatch: {stored!r}")
    _require(
        stored["collections"] == expected_collections,
        f"standalone attachment collections {stored['collections']!r}, expected {expected_collections!r}",
    )


class SmokeRun(NamedTuple):
    """What every proof step needs: the client, the add-on endpoints from /version,
    the library for read-back, this run's unique suffix, and the keys of top-level
    items this run created. Each step appends a key as soon as its creation response
    validates, so the run trashes it even after a later failure."""

    http: httpx.Client
    write_path: str
    attach_path: str
    library_id: str
    suffix: str
    created: list[str]

    def write(self, payload: JsonObject, schema: TypeAdapter[ResultT]) -> ResultT:
        return _post_write(self.http, self.write_path, payload, schema)

    def item(self, item_key: str) -> Item:
        return _get_item(self.http, self.library_id, item_key)


def _prove_version(http: httpx.Client, expected_version: str) -> VersionResponse:
    """/version reports the add-on under proof, its endpoints, and every capability
    this proof uses, after Zotero has loaded its translators."""
    version_payload = _get(http, "/version", VERSION)
    _require(
        version_payload["version"] == expected_version,
        f"Expected add-on version {expected_version}, got {version_payload['version']!r}",
    )
    endpoints = version_payload["endpoints"]
    _require(endpoints["attach"].startswith("/"), f"Invalid attach endpoint: {endpoints['attach']!r}")
    _require(endpoints["write"].startswith("/"), f"Invalid write endpoint: {endpoints['write']!r}")
    capabilities = version_payload["capabilities"]
    for capability in ("attach", "attach_bytes", "attach_standalone", "write", "version_probe", "import_bibtex"):
        _require(capability in capabilities, f"Missing required capability {capability!r}: {capabilities!r}")
    _require(version_payload["translators_ready"] is True, f"Zotero has not loaded its translators: {version_payload!r}")
    return version_payload


def _create_book(smoke: SmokeRun, title: str, tags: list[str]) -> str:
    """create_item answers a key for a new book, which goes into `created`. Returns it."""
    create_result = smoke.write(
        {
            "operation": "create_item",
            "item_type": "book",
            "fields": {"title": title, **BOOK_FIELDS},
            "tags": list[JsonValue](tags),
        },
        ITEM_KEY,
    )
    item_key = create_result["item_key"]
    smoke.created.append(item_key)
    _require(bool(item_key), f"create_item did not return item_key: {create_result!r}")
    return item_key


def _prove_create_item(smoke: SmokeRun, tags: list[str]) -> str:
    """create_item stores a book with its title and tags. Returns its key."""
    title = f"live-smoke-item-{smoke.suffix}"
    item_key = _create_book(smoke, title, tags)
    created_item = smoke.item(item_key)
    _require(created_item["data"]["title"] == title, f"Unexpected item title: {created_item!r}")
    created_tags = set(_tag_names(created_item))
    _require(created_tags == set(tags), f"Unexpected initial tags: {created_tags!r}")
    return item_key


def _prove_import_bibtex(smoke: SmokeRun) -> str:
    """import_bibtex stores the entry with its title. Returns the imported item's key."""
    # The suffix goes into the record's key and title: import deduplicates on title.
    bibtex = BIBTEX_RECORD.read_text(encoding="utf-8").replace("__UID__", smoke.suffix)
    bibtex_title = f"bibtex-fixture-{smoke.suffix}"
    bibtex_result = smoke.write({"operation": "import_bibtex", "bibtex": bibtex}, ITEM_KEY)
    bibtex_item_key = bibtex_result["item_key"]
    smoke.created.append(bibtex_item_key)
    _require(bool(bibtex_item_key), f"import_bibtex did not return item_key: {bibtex_result!r}")
    bibtex_item = smoke.item(bibtex_item_key)
    _require(
        bibtex_item["data"]["title"] == bibtex_title,
        f"import_bibtex read-back title mismatch: {bibtex_item!r}",
    )
    return bibtex_item_key


def _attach_child_pdf(smoke: SmokeRun, item_key: str) -> str:
    """/attach with item_key answers a child placement of the uploaded bytes under
    that item. Returns the attachment key."""
    attach_result = _post_write(
        smoke.http,
        smoke.attach_path,
        {"item_key": item_key, **_pdf_upload("Live Smoke PDF", "live-smoke.pdf")},
        CHILD_ATTACH,
    )
    attachment_key = attach_result["attachment_key"]
    _require(bool(attachment_key), f"Missing attachment_key: {attach_result!r}")
    _require(
        attach_result["details"]["parent_item_key"] == item_key,
        f"child /attach reported parent {attach_result['details']['parent_item_key']!r}, expected {item_key!r}",
    )
    _require(
        attach_result["details"]["source_mode"] == "bytes",
        f"Expected bytes source_mode, got: {attach_result!r}",
    )
    return attachment_key


def _prove_child_attach(smoke: SmokeRun, item_key: str) -> str:
    """/attach with item_key stores the uploaded bytes as a PDF child of that item.
    Returns the attachment key."""
    attachment_key = _attach_child_pdf(smoke, item_key)
    children = _get_children(smoke.http, smoke.library_id, item_key)
    matches = [child for child in children if child["key"] == attachment_key]
    _require(len(matches) == 1, f"Attached PDF {attachment_key} not found once in children: {children!r}")
    matching_attachment = matches[0]
    _require(
        matching_attachment["data"].get("contentType") == "application/pdf",
        f"Attachment contentType mismatch: {matching_attachment!r}",
    )
    _require(
        matching_attachment["data"]["title"] == "Live Smoke PDF",
        f"Attachment title mismatch: {matching_attachment!r}",
    )
    return attachment_key


def _prove_delete_tag(smoke: SmokeRun, item_key: str, doomed_tag: str, keep_tag: str) -> None:
    """delete_tag removes one tag from the item and keeps the other."""
    smoke.write({"operation": "delete_tag", "tag_name": doomed_tag}, ACK)
    updated_tags = set(_tag_names(smoke.item(item_key)))
    _require(doomed_tag not in updated_tags, f"delete_tag left doomed tag behind: {updated_tags!r}")
    _require(keep_tag in updated_tags, f"delete_tag removed the keep tag: {updated_tags!r}")


def _prove_collection_membership(smoke: SmokeRun, item_key: str) -> str:
    """add_item_to_collection and remove_item_from_collection change the item's
    collections. Returns the key of the collection this step created.

    Both handlers map an item's collection IDs back to keys through
    Zotero.Collections.get, whose documented `false` sentinel was dereferenced
    directly; nothing exercised that path at the real boundary.
    """
    collection_key = smoke.write(
        {"operation": "create_collection", "name": f"live-smoke-collection-{smoke.suffix}"},
        COLLECTION,
    )["details"]["collection_key"]
    _prove_add_item_to_collection(smoke, item_key, collection_key)
    _prove_remove_item_from_collection(smoke, item_key, collection_key)
    return collection_key


def _prove_add_item_to_collection(smoke: SmokeRun, item_key: str, collection_key: str) -> None:
    """add_item_to_collection puts the collection in the item's collections."""
    smoke.write(
        {"operation": "add_item_to_collection", "item_key": item_key, "collection_key": collection_key},
        ACK,
    )
    _require(
        collection_key in smoke.item(item_key)["data"]["collections"],
        "add_item_to_collection did not attach the collection",
    )


def _prove_remove_item_from_collection(smoke: SmokeRun, item_key: str, collection_key: str) -> None:
    """remove_item_from_collection takes the collection out of the item's collections."""
    smoke.write(
        {"operation": "remove_item_from_collection", "item_key": item_key, "collection_key": collection_key},
        ACK,
    )
    _require(
        collection_key not in smoke.item(item_key)["data"]["collections"],
        "remove_item_from_collection left the collection attached",
    )


def _prove_tag_operations(smoke: SmokeRun, item_key: str, keep_tag: str) -> None:
    """add, set, remove, rename and merge tags, all scoped to this run's own tags."""
    tag_a = f"live-smoke-a-{smoke.suffix}"
    tag_b = f"live-smoke-b-{smoke.suffix}"
    tag_c = f"live-smoke-c-{smoke.suffix}"
    _prove_add_item_tags(smoke, item_key, tag_a)
    _prove_automatic_tag_becomes_manual(smoke, item_key, f"live-smoke-auto-{smoke.suffix}")
    _prove_set_item_tags(smoke, item_key, [keep_tag, tag_a, tag_b])
    _prove_remove_item_tags(smoke, item_key, tag_b)
    _prove_rename_tag(smoke, item_key, tag_a, tag_c)
    _prove_merge_tags(smoke, item_key, tag_c, keep_tag)


def _add_item_tags(smoke: SmokeRun, item_key: str, tag: str) -> list[str]:
    """add_item_tags with one tag. Returns the tags it reports as added."""
    payload: JsonObject = {"operation": "add_item_tags", "item_key": item_key, "tags": [tag]}
    return smoke.write(payload, ADDED_TAGS)["details"]["added_tags"]


def _prove_add_item_tags(smoke: SmokeRun, item_key: str, tag: str) -> None:
    """add_item_tags adds the tag to the item and reports it as added; a second add
    reports nothing, because the item already carries the manual tag."""
    _require(_add_item_tags(smoke, item_key, tag) == [tag], "add_item_tags did not report the new tag")
    _require(tag in _tag_names(smoke.item(item_key)), "add_item_tags did not add the tag")
    _require(_add_item_tags(smoke, item_key, tag) == [], "add_item_tags reported a tag the item already had")


def _tag_type(smoke: SmokeRun, item_key: str, name: str) -> int:
    """The type of the item's tag of that name: 0 manual, 1 automatic."""
    tags = [tag for tag in smoke.item(item_key)["data"]["tags"] if tag["tag"] == name]
    _require(len(tags) == 1, f"expected one tag {name!r} on {item_key}, got {tags!r}")
    return tags[0].get("type", 0)


def _prove_automatic_tag_becomes_manual(smoke: SmokeRun, item_key: str, tag: str) -> None:
    """add_item_tags on an automatic tag of the same name makes it manual and reports it as added."""
    code = (
        "let item = await Zotero.Items.getByLibraryAndKeyAsync("
        f"Zotero.Libraries.userLibraryID, {json.dumps(item_key)});\n"
        f"item.addTag({json.dumps(tag)}, 1);\n"
        "await item.saveTx();\n"
        "return true;"
    )
    _run_javascript(smoke.http, smoke.write_path, code, JS_TRUE)
    _require(_tag_type(smoke, item_key, tag) == 1, "the automatic tag was not stored as automatic")
    _require(_add_item_tags(smoke, item_key, tag) == [tag], "add_item_tags did not report the automatic tag")
    _require(_tag_type(smoke, item_key, tag) == 0, "add_item_tags left the tag automatic")


def _prove_set_item_tags(smoke: SmokeRun, item_key: str, tags: list[str]) -> None:
    """set_item_tags replaces the item's tags with exactly the given set."""
    smoke.write({"operation": "set_item_tags", "item_key": item_key, "tags": list[JsonValue](tags)}, ACK)
    _require(set(_tag_names(smoke.item(item_key))) == set(tags), "set_item_tags did not replace the tag set")


def _prove_remove_item_tags(smoke: SmokeRun, item_key: str, tag: str) -> None:
    """remove_item_tags takes the tag off the item."""
    smoke.write({"operation": "remove_item_tags", "item_key": item_key, "tags": [tag]}, ACK)
    _require(tag not in _tag_names(smoke.item(item_key)), "remove_item_tags left the tag attached")


def _prove_rename_tag(smoke: SmokeRun, item_key: str, old_name: str, new_name: str) -> None:
    """rename_tag gives the item's tag its new name."""
    smoke.write({"operation": "rename_tag", "old_name": old_name, "new_name": new_name}, ACK)
    _require(new_name in _tag_names(smoke.item(item_key)), "rename_tag did not apply the new name")


def _prove_merge_tags(smoke: SmokeRun, item_key: str, source_tag: str, target_tag: str) -> None:
    """merge_tags folds the source tag into the target tag on the item."""
    smoke.write({"operation": "merge_tags", "source_tags": [source_tag], "target_tag": target_tag}, ACK)
    merged_tags = _tag_names(smoke.item(item_key))
    _require(
        source_tag not in merged_tags and target_tag in merged_tags,
        "merge_tags did not fold the source into the target",
    )


def _prove_item_and_child_edits(smoke: SmokeRun, item_key: str, attachment_key: str) -> None:
    """update_item_fields persists the title; the attachment, note and URL child
    operations succeed."""
    new_title = f"Live Smoke Retitled {smoke.suffix}"
    smoke.write({"operation": "update_item_fields", "item_key": item_key, "fields": {"title": new_title}}, ACK)
    _require(smoke.item(item_key)["data"]["title"] == new_title, "update_item_fields did not persist the title")

    smoke.write(
        {"operation": "update_attachment_title", "attachment_key": attachment_key, "new_title": "Live Smoke PDF Retitled"},
        ACK,
    )
    note_key = smoke.write(
        {"operation": "attach_note", "parent_item_key": item_key, "note_text": "live smoke note"}, NOTE
    )["note_key"]
    smoke.write({"operation": "update_note", "note_key": note_key, "new_content": "live smoke note updated"}, ACK)
    smoke.write(
        {"operation": "attach_url", "parent_item_key": item_key, "url": "https://example.com/live-smoke"},
        ACK,
    )


def _prove_copy_lifecycle(smoke: SmokeRun, item_key: str) -> None:
    """copy_item, then use the copy as the disposable side of trash, restore,
    replace and merge."""
    copy_key = smoke.write({"operation": "copy_item", "item_key": item_key}, COPY)["new_item_key"]
    smoke.created.append(copy_key)

    smoke.write({"operation": "trash_item", "item_key": copy_key}, ACK)
    smoke.write({"operation": "restore_item", "item_key": copy_key}, ACK)
    _require(smoke.item(copy_key)["data"].get("deleted") is not True, "restore_item left the item trashed")

    replaced_title = f"Live Smoke Replaced {smoke.suffix}"
    smoke.write(
        {"operation": "replace_item_json", "item_key": copy_key, "item_json": {"itemType": "journalArticle", "title": replaced_title}},
        ACK,
    )
    _require(
        smoke.item(copy_key)["data"]["title"] == replaced_title,
        "replace_item_json did not persist the replacement",
    )
    smoke.write({"operation": "merge_items", "source_key": copy_key, "target_key": item_key}, ACK)


def _prove_collection_hierarchy(smoke: SmokeRun, item_key: str, collection_key: str) -> None:
    """rename, move, set_item_collections, merge and trash, all on this run's own collections."""
    parent_key = smoke.write(
        {"operation": "create_collection", "name": f"live-smoke-parent-{smoke.suffix}"}, COLLECTION
    )["details"]["collection_key"]

    smoke.write(
        {"operation": "rename_collection", "collection_key": collection_key, "new_name": f"live-smoke-renamed-{smoke.suffix}"},
        ACK,
    )
    smoke.write({"operation": "move_collection", "collection_key": collection_key, "new_parent_key": parent_key}, ACK)
    smoke.write({"operation": "set_item_collections", "item_key": item_key, "collection_keys": [parent_key]}, ACK)
    _require(
        smoke.item(item_key)["data"]["collections"] == [parent_key],
        "set_item_collections did not replace the collection set",
    )
    smoke.write({"operation": "merge_collections", "source_keys": [collection_key], "target_key": parent_key}, ACK)
    smoke.write({"operation": "trash_collection", "collection_key": parent_key}, ACK)


def _standalone_pane_rows(smoke: SmokeRun, collection_key: str) -> tuple[str, str]:
    """The collection pane's row ids for this run's collection and for the library root."""
    collection_id = _run_javascript(
        smoke.http,
        smoke.write_path,
        f"return Zotero.Collections.getByLibraryAndKey(Zotero.Libraries.userLibraryID, {collection_key!r}).id;",
        JS_INT,
    )
    user_library_id = _run_javascript(smoke.http, smoke.write_path, "return Zotero.Libraries.userLibraryID;", JS_INT)
    return f"C{collection_id}", f"L{user_library_id}"


def _prove_standalone_in_collection(smoke: SmokeRun, collection_row: str, collection_key: str) -> str:
    """With a collection selected, /attach without item_key stores the PDF in that
    collection. Returns the attachment key."""
    _select_pane_row(smoke.http, smoke.write_path, collection_row)
    title = f"Live Smoke Standalone {collection_row} {smoke.suffix}"
    in_collection = _store_standalone_pdf(smoke.http, smoke.attach_path, title, COLLECTION_ATTACH)
    smoke.created.append(in_collection["attachment_key"])
    _require(
        in_collection["details"]["collection_key"] == collection_key,
        f"standalone /attach reported collection {in_collection['details']['collection_key']!r}, expected {collection_key!r}",
    )
    _require_stored_standalone(smoke.http, smoke.library_id, in_collection["attachment_key"], title, [collection_key])
    return in_collection["attachment_key"]


def _prove_standalone_at_root(smoke: SmokeRun, root_row: str) -> str:
    """With the library root selected, /attach without item_key stores the PDF in no
    collection. Returns the attachment key."""
    _select_pane_row(smoke.http, smoke.write_path, root_row)
    title = f"Live Smoke Standalone {root_row} {smoke.suffix}"
    at_root = _store_standalone_pdf(smoke.http, smoke.attach_path, title, ROOT_ATTACH)
    smoke.created.append(at_root["attachment_key"])
    _require_stored_standalone(smoke.http, smoke.library_id, at_root["attachment_key"], title, [])
    return at_root["attachment_key"]


def _prove_standalone_attach(smoke: SmokeRun) -> list[str]:
    """/attach without item_key stores a parentless PDF where the pane points, in a
    selected collection and at the library root, then restores the user's pane
    selection. Each step adds its attachment key to `created` as soon as the response
    validates. Returns the two attachment keys."""
    original_row = _run_javascript(
        smoke.http, smoke.write_path, "return Zotero.getActiveZoteroPane().getCollectionTreeRow().id;", JS_TEXT
    )
    collection_key = smoke.write(
        {"operation": "create_collection", "name": f"live-smoke-standalone-{smoke.suffix}"}, COLLECTION
    )["details"]["collection_key"]
    try:
        collection_row, root_row = _standalone_pane_rows(smoke, collection_key)
        in_collection_key = _prove_standalone_in_collection(smoke, collection_row, collection_key)
        return [in_collection_key, _prove_standalone_at_root(smoke, root_row)]
    finally:
        _select_pane_row(smoke.http, smoke.write_path, original_row)
        smoke.write({"operation": "trash_collection", "collection_key": collection_key}, ACK)


def _prove_trash_item(smoke: SmokeRun, item_key: str) -> None:
    """trash_item marks the item deleted."""
    smoke.write({"operation": "trash_item", "item_key": item_key}, ACK)
    trashed_item = _wait_for_deleted(smoke.http, smoke.library_id, item_key)
    _require(
        trashed_item["data"].get("deleted") is True,
        f"trash_item did not mark the item deleted: {trashed_item!r}",
    )


def _prove_add_on_surface(http: httpx.Client, expected_version: str) -> VersionResponse:
    """/version, /openapi.yaml and every state of the /write bearer gate. Returns the
    /version payload."""
    version_payload = _prove_version(http, expected_version)
    write_path = version_payload["endpoints"]["write"]
    _prove_openapi_endpoint(http, write_path)
    _prove_bearer_gate(http, write_path)
    return version_payload


def _create_collection(smoke: SmokeRun, name: str, parent_key: str | None) -> str:
    payload: JsonObject = {"operation": "create_collection", "name": f"{name}-{smoke.suffix}"}
    if parent_key is not None:
        payload["parent_key"] = parent_key
    return smoke.write(payload, COLLECTION)["details"]["collection_key"]


def _source_and_child_state(smoke: SmokeRun, source_key: str, child_key: str) -> tuple[bool, str]:
    """Whether the source collection is trashed, and the parent key of its child."""
    code = (
        "let get = (key) => Zotero.Collections.getByLibraryAndKey(Zotero.Libraries.userLibraryID, key);\n"
        f"return [get({json.dumps(source_key)}).deleted, get({json.dumps(child_key)}).parentKey];"
    )
    return _run_javascript(smoke.http, smoke.write_path, code, JS_MERGE_STATE)


def _prove_merge_into_trashed_descendant(smoke: SmokeRun) -> None:
    """merge_collections refuses with 409, before any change, a target that is a
    trashed descendant below a direct child of the source."""
    source_key = _create_collection(smoke, "live-smoke-merge-source", None)
    try:
        child_key = _create_collection(smoke, "live-smoke-merge-child", source_key)
        grandchild_key = _create_collection(smoke, "live-smoke-merge-grandchild", child_key)
        smoke.write({"operation": "trash_collection", "collection_key": grandchild_key}, ACK)
        payload = {"operation": "merge_collections", "source_keys": [source_key], "target_key": grandchild_key}
        response = smoke.http.post(smoke.write_path, json=payload)
        _require(response.status_code == 409, f"merge into a trashed grandchild returned HTTP {response.status_code}: {response.text}")
        ERROR.validate_json(response.content)
        _require(
            _source_and_child_state(smoke, source_key, child_key) == (False, source_key),
            "the refused merge changed the source collection or its child",
        )
    finally:
        smoke.write({"operation": "trash_collection", "collection_key": source_key}, ACK)


def _prove_item_edits(smoke: SmokeRun, item_key: str, attachment_key: str, doomed_tag: str, keep_tag: str) -> None:
    """Every tag, collection, field, child and copy operation on the created item."""
    _prove_delete_tag(smoke, item_key, doomed_tag, keep_tag)
    collection_key = _prove_collection_membership(smoke, item_key)
    _prove_tag_operations(smoke, item_key, keep_tag)
    _prove_item_and_child_edits(smoke, item_key, attachment_key)
    _prove_copy_lifecycle(smoke, item_key)
    _prove_collection_hierarchy(smoke, item_key, collection_key)
    _prove_merge_into_trashed_descendant(smoke)


def _prove_library_writes(smoke: SmokeRun, version: str) -> SmokeReport:
    """Every write this run makes in the library, in order, and the report of its keys."""
    doomed_tag = f"live-smoke-delete-{smoke.suffix}"
    keep_tag = f"live-smoke-keep-{smoke.suffix}"
    item_key = _prove_create_item(smoke, [doomed_tag, keep_tag])
    bibtex_item_key = _prove_import_bibtex(smoke)
    attachment_key = _prove_child_attach(smoke, item_key)
    _prove_item_edits(smoke, item_key, attachment_key, doomed_tag, keep_tag)
    standalone_keys = _prove_standalone_attach(smoke)
    _prove_trash_item(smoke, item_key)
    return {
        "success": True,
        "version": version,
        "item_key": item_key,
        "bibtex_item_key": bibtex_item_key,
        "attachment_key": attachment_key,
        "deleted_tag": doomed_tag,
        "kept_tag": keep_tag,
        "standalone_attachment_keys": standalone_keys,
    }


def run(http: httpx.Client, args: SmokeArgs) -> SmokeReport:
    version_payload = _prove_add_on_surface(http, args.expected_version)
    smoke = SmokeRun(
        http=http,
        write_path=version_payload["endpoints"]["write"],
        attach_path=version_payload["endpoints"]["attach"],
        library_id=args.library_id,
        suffix=uuid4().hex[:10],
        created=[],
    )
    try:
        return _prove_library_writes(smoke, version_payload["version"])
    finally:
        _trash_created(http, smoke.write_path, smoke.created)


def parse_args() -> SmokeArgs:
    parser = argparse.ArgumentParser(description="Run a live smoke proof against the local-write-api add-on.")
    parser.add_argument("--base-url", default="http://127.0.0.1:23119", help="Base URL for the local Zotero server")
    parser.add_argument("--library-id", default="0", help="Local Zotero library id for read-back checks")
    parser.add_argument(
        "--expected-version",
        required=True,
        help="Add-on version under proof; the run fails unless /version reports exactly this version",
    )
    parser.add_argument(
        "--token",
        type=BearerAuth,
        default=httpx.Auth(),
        help="Bearer token matching the running instance's localWriteAPI.token pref; "
        "required when that pref is set",
    )
    return parser.parse_args(namespace=SmokeArgs())


def main() -> int:
    args = parse_args()
    # /attach uploads the PDF bytes inline, so the ceiling covers the slowest call.
    http = httpx.Client(
        base_url=args.base_url.rstrip("/"),
        headers={"Accept": "application/json"},
        auth=args.token,
        timeout=60.0,
    )
    try:
        with http:
            result = run(http, args)
    except (SmokeFailure, ValidationError, httpx.TransportError) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
