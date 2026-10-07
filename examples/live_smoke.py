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
from typing import Generic, Literal, NotRequired, TypeVar
from uuid import uuid4

import httpx
from pydantic import JsonValue, TypeAdapter, ValidationError
from typing_extensions import TypedDict

TOKEN_PREF = "extensions.zotero.localWriteAPI.token"


PDF_BYTES = (
    b"%PDF-1.4\n"
    b"%live-smoke-proof\n"
    b"1 0 obj\n<<>>\nendobj\n"
    b"trailer\n<<>>\n%%EOF\n"
)

JsonObject = dict[str, JsonValue]
ResultT = TypeVar("ResultT")


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


class SmokeArgs(argparse.Namespace):
    """Typed view of the parsed command line; parse_args() fills every attribute."""

    base_url: str
    library_id: str
    expected_version: str
    token: str


ACK = TypeAdapter(Ack)
ITEM_KEY = TypeAdapter(ItemKeySuccess)
NOTE = TypeAdapter(NoteSuccess)
COPY = TypeAdapter(CopySuccess)
COLLECTION = TypeAdapter(CollectionSuccess)
CHILD_ATTACH = TypeAdapter(ChildAttachSuccess)
COLLECTION_ATTACH = TypeAdapter(CollectionAttachSuccess)
ROOT_ATTACH = TypeAdapter(RootAttachSuccess)
VERSION = TypeAdapter(VersionResponse)
ITEM = TypeAdapter(Item)
CHILDREN = TypeAdapter(list[ChildItem])
JS_TEXT = TypeAdapter(JavascriptSuccess[str])
JS_INT = TypeAdapter(JavascriptSuccess[int])
JS_TRUE = TypeAdapter(JavascriptSuccess[Literal[True]])


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


def _post(
    http: httpx.Client,
    path: str,
    payload: JsonObject,
    headers: dict[str, str],
    schema: TypeAdapter[ResultT],
) -> ResultT:
    response = http.post(path, json=payload, headers=headers)
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


def _require_write_status(
    http: httpx.Client, write_path: str, headers: dict[str, str], expected: int, case: str
) -> None:
    """POST an empty body to /write and require `expected` as the HTTP status."""
    response = http.post(write_path, json={}, headers=headers)
    _require(
        response.status_code == expected,
        f"/write {case} returned HTTP {response.status_code}, expected {expected}: {response.text[:200]!r}",
    )


def _prove_bearer_auth(http: httpx.Client, write_path: str, token: str) -> None:
    """With the token pref set, /write demands a matching bearer token.

    Auth is checked before the request body, so an empty body isolates the gate:
    no token -> 401; correct token -> the body-validation 400, never 401. This
    proves the gate without creating or trashing any library item.
    """
    _require_write_status(http, write_path, {}, 401, "without a token")
    _require_write_status(
        http,
        write_path,
        {"Authorization": f"Bearer {token}"},
        400,
        "with the token (body validation)",
    )
    _require_write_status(
        http, write_path, {"Authorization": "Bearer not-the-token"}, 401, "with a wrong token"
    )


def _run_javascript(
    http: httpx.Client,
    write_path: str,
    code: str,
    headers: dict[str, str],
    schema: TypeAdapter[JavascriptSuccess[ResultT]],
) -> ResultT:
    payload: JsonObject = {"operation": "run_javascript", "code": code}
    return _post(http, write_path, payload, headers, schema)["details"]["result"]


def _prove_bearer_gate(http: httpx.Client, write_path: str, token: str) -> None:
    """Always exercise the bearer gate, self-provisioning when no token is given.

    With an externally-set token (--token), prove against it directly. Otherwise
    set a random token through the open loopback run_javascript op, prove the
    gate, then clear it so the caller's default loopback-open state is restored.
    """
    if token:
        _prove_bearer_auth(http, write_path, token)
        return
    open_status = http.post(write_path, json={}).status_code
    _require(
        open_status != 401,
        "instance already requires a token but none was given; pass --token to prove the gate",
    )
    probe_token = secrets.token_hex(16)
    # Printed before it is written: this value goes into a persistent pref on a real
    # profile, so a run interrupted between the set and the clear would otherwise leave
    # the instance behind a token nobody knows. With it on stderr the operator can
    # recover by clearing extensions.zotero.localWriteAPI.token in the Config Editor,
    # or by replaying the clear with this bearer.
    print(f"live-smoke: provisioning temporary write token {probe_token}", file=sys.stderr)
    # run_javascript serializes the code's return value, so each snippet must
    # return something JSON-encodable (a bare Prefs.set/clear returns undefined).
    _run_javascript(
        http,
        write_path,
        f"Zotero.Prefs.set({TOKEN_PREF!r}, {probe_token!r}, true); return true;",
        {},
        JS_TRUE,
    )
    auth = {"Authorization": f"Bearer {probe_token}"}
    try:
        _prove_bearer_auth(http, write_path, probe_token)
    finally:
        _run_javascript(
            http,
            write_path,
            f"Zotero.Prefs.clear({TOKEN_PREF!r}, true); return true;",
            auth,
            JS_TRUE,
        )

    # The published-without-token deny branch (publicBaseURL set, token unset) is NOT
    # proved here on purpose. Reaching that state means /write denies every request,
    # including the run_javascript needed to clear either pref, so a proof that entered
    # it could not get back out and would leave the instance unusable. Proving it needs
    # a disposable profile, not the operator's own.


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


# Bearer header applied to every /write and /attach call, populated by run()
# from --token. When the instance's token pref is set, the item-lifecycle calls
# must authenticate too, not just the dedicated gate proof.
_WRITE_AUTH: dict[str, str] = {}


def _post_write(
    http: httpx.Client, write_path: str, payload: JsonObject, schema: TypeAdapter[ResultT]
) -> ResultT:
    return _post(http, write_path, payload, _WRITE_AUTH, schema)


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
        _WRITE_AUTH,
        JS_TRUE,
    )


def _store_standalone_pdf(
    http: httpx.Client, attach_path: str, title: str, placement: TypeAdapter[ResultT]
) -> ResultT:
    """POST a parentless PDF; `placement` rejects a response for any other placement."""
    return _post_write(
        http,
        attach_path,
        {
            "title": title,
            "file_name": "live-smoke-standalone.pdf",
            "file_bytes_base64": base64.b64encode(PDF_BYTES).decode("ascii"),
        },
        placement,
    )


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


def _prove_standalone_attach(
    http: httpx.Client,
    write_path: str,
    attach_path: str,
    library_id: str,
    suffix: str,
    created: list[str],
) -> list[str]:
    """/attach without item_key stores a parentless PDF where the pane points.

    Both targets are proved: a selected collection, and the library root. The
    user's pane selection is restored afterward. Every attachment key goes into
    `created` as soon as its response validates, so the caller trashes it on any
    later failure. Returns the two attachment keys.
    """
    original_row = _run_javascript(
        http,
        write_path,
        "return Zotero.getActiveZoteroPane().getCollectionTreeRow().id;",
        _WRITE_AUTH,
        JS_TEXT,
    )
    collection_result = _post_write(
        http,
        write_path,
        {"operation": "create_collection", "name": f"live-smoke-standalone-{suffix}"},
        COLLECTION,
    )
    collection_key = collection_result["details"]["collection_key"]
    try:
        collection_id = _run_javascript(
            http,
            write_path,
            f"return Zotero.Collections.getByLibraryAndKey(Zotero.Libraries.userLibraryID, {collection_key!r}).id;",
            _WRITE_AUTH,
            JS_INT,
        )
        user_library_id = _run_javascript(
            http, write_path, "return Zotero.Libraries.userLibraryID;", _WRITE_AUTH, JS_INT
        )
        collection_row = f"C{collection_id}"
        _select_pane_row(http, write_path, collection_row)
        in_collection_title = f"Live Smoke Standalone {collection_row} {suffix}"
        in_collection = _store_standalone_pdf(http, attach_path, in_collection_title, COLLECTION_ATTACH)
        created.append(in_collection["attachment_key"])
        _require(
            in_collection["details"]["collection_key"] == collection_key,
            f"standalone /attach reported collection {in_collection['details']['collection_key']!r}, expected {collection_key!r}",
        )
        _require_stored_standalone(
            http, library_id, in_collection["attachment_key"], in_collection_title, [collection_key]
        )

        root_row = f"L{user_library_id}"
        _select_pane_row(http, write_path, root_row)
        at_root_title = f"Live Smoke Standalone {root_row} {suffix}"
        at_root = _store_standalone_pdf(http, attach_path, at_root_title, ROOT_ATTACH)
        created.append(at_root["attachment_key"])
        _require_stored_standalone(http, library_id, at_root["attachment_key"], at_root_title, [])
        return [in_collection["attachment_key"], at_root["attachment_key"]]
    finally:
        _select_pane_row(http, write_path, original_row)
        _post_write(
            http, write_path, {"operation": "trash_collection", "collection_key": collection_key}, ACK
        )


def run(http: httpx.Client, args: SmokeArgs) -> SmokeReport:
    if args.token:
        _WRITE_AUTH["Authorization"] = f"Bearer {args.token}"
    library_id = args.library_id
    suffix = uuid4().hex[:10]
    doomed_tag = f"live-smoke-delete-{suffix}"
    keep_tag = f"live-smoke-keep-{suffix}"
    # Keys of top-level items this run created, appended as soon as each
    # creation response validates, so the run trashes them even after a failure.
    created: list[str] = []

    version_payload = _get(http, "/version", VERSION)
    if args.expected_version:
        _require(
            version_payload["version"] == args.expected_version,
            f"Expected add-on version {args.expected_version}, got {version_payload['version']!r}",
        )

    attach_path = version_payload["endpoints"]["attach"]
    write_path = version_payload["endpoints"]["write"]
    _require(attach_path.startswith("/"), f"Invalid attach endpoint: {attach_path!r}")
    _require(write_path.startswith("/"), f"Invalid write endpoint: {write_path!r}")

    capabilities = version_payload["capabilities"]
    for capability in ("attach", "attach_bytes", "attach_standalone", "write", "version_probe", "import_bibtex"):
        _require(capability in capabilities, f"Missing required capability {capability!r}: {capabilities!r}")
    _require(version_payload["translators_ready"] is True, f"Zotero has not loaded its translators: {version_payload!r}")

    _prove_openapi_endpoint(http, write_path)
    # Always prove the bearer gate: with --token against a pre-authed instance,
    # otherwise self-provisioning a throwaway token and clearing it after.
    _prove_bearer_gate(http, write_path, args.token)

    try:
        create_result = _post_write(
            http,
            write_path,
            {
                "operation": "create_item",
                "item_type": "book",
                "fields": {
                    "title": f"live-smoke-item-{suffix}",
                    "creators": [
                        {
                            "creatorType": "author",
                            "firstName": "Local",
                            "lastName": "Smoke",
                        }
                    ],
                    "date": "2026",
                    "publisher": "Local Write API Smoke",
                },
                "tags": [doomed_tag, keep_tag],
            },
            ITEM_KEY,
        )
        item_key = create_result["item_key"]
        created.append(item_key)
        _require(bool(item_key), f"create_item did not return item_key: {create_result!r}")

        created_item = _get_item(http, library_id, item_key)
        _require(created_item["data"]["title"] == f"live-smoke-item-{suffix}", f"Unexpected item title: {created_item!r}")
        created_tags = set(_tag_names(created_item))
        _require(created_tags == {doomed_tag, keep_tag}, f"Unexpected initial tags: {created_tags!r}")

        bibtex_title = f"live-smoke-bibtex-{suffix}"
        bibtex_result = _post_write(
            http,
            write_path,
            {
                "operation": "import_bibtex",
                "bibtex": (
                    f"@book{{localwritesmoke{suffix},\n"
                    f"  title = {{{bibtex_title}}},\n"
                    "  author = {BibTeX Smoke},\n"
                    "  year = {2026},\n"
                    "  publisher = {Local Write API Smoke}\n"
                    "}\n"
                ),
            },
            ITEM_KEY,
        )
        bibtex_item_key = bibtex_result["item_key"]
        created.append(bibtex_item_key)
        _require(bool(bibtex_item_key), f"import_bibtex did not return item_key: {bibtex_result!r}")
        bibtex_item = _get_item(http, library_id, bibtex_item_key)
        _require(
            bibtex_item["data"]["title"] == bibtex_title,
            f"import_bibtex read-back title mismatch: {bibtex_item!r}",
        )

        attach_result = _post_write(
            http,
            attach_path,
            {
                "item_key": item_key,
                "title": "Live Smoke PDF",
                "file_name": "live-smoke.pdf",
                "file_bytes_base64": base64.b64encode(PDF_BYTES).decode("ascii"),
            },
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

        children = _get_children(http, library_id, item_key)
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

        _post_write(http, write_path, {"operation": "delete_tag", "tag_name": doomed_tag}, ACK)

        updated_item = _get_item(http, library_id, item_key)
        updated_tags = set(_tag_names(updated_item))
        _require(doomed_tag not in updated_tags, f"delete_tag left doomed tag behind: {updated_tags!r}")
        _require(keep_tag in updated_tags, f"delete_tag removed the keep tag: {updated_tags!r}")

        # Collection round-trip. Both handlers map an item's collection IDs back to
        # keys through Zotero.Collections.get, whose documented `false` sentinel was
        # dereferenced directly; nothing exercised that path at the real boundary.
        collection_name = f"live-smoke-collection-{suffix}"
        create_collection_result = _post_write(
            http,
            write_path,
            {"operation": "create_collection", "name": collection_name},
            COLLECTION,
        )
        collection_key = create_collection_result["details"]["collection_key"]

        _post_write(
            http,
            write_path,
            {
                "operation": "add_item_to_collection",
                "item_key": item_key,
                "collection_key": collection_key,
            },
            ACK,
        )
        _require(
            collection_key in _get_item(http, library_id, item_key)["data"]["collections"],
            "add_item_to_collection did not attach the collection",
        )

        _post_write(
            http,
            write_path,
            {
                "operation": "remove_item_from_collection",
                "item_key": item_key,
                "collection_key": collection_key,
            },
            ACK,
        )
        _require(
            collection_key not in _get_item(http, library_id, item_key)["data"]["collections"],
            "remove_item_from_collection left the collection attached",
        )

        # Tag operations, all scoped to this run's own tags.
        tag_a = f"live-smoke-a-{suffix}"
        tag_b = f"live-smoke-b-{suffix}"
        tag_c = f"live-smoke-c-{suffix}"

        _post_write(http, write_path, {"operation": "add_item_tags", "item_key": item_key, "tags": [tag_a]}, ACK)
        _require(tag_a in _tag_names(_get_item(http, library_id, item_key)), "add_item_tags did not add the tag")

        _post_write(http, write_path, {"operation": "set_item_tags", "item_key": item_key, "tags": [keep_tag, tag_a, tag_b]}, ACK)
        _require(set(_tag_names(_get_item(http, library_id, item_key))) == {keep_tag, tag_a, tag_b}, "set_item_tags did not replace the tag set")

        _post_write(http, write_path, {"operation": "remove_item_tags", "item_key": item_key, "tags": [tag_b]}, ACK)
        _require(tag_b not in _tag_names(_get_item(http, library_id, item_key)), "remove_item_tags left the tag attached")

        _post_write(http, write_path, {"operation": "rename_tag", "old_name": tag_a, "new_name": tag_c}, ACK)
        _require(tag_c in _tag_names(_get_item(http, library_id, item_key)), "rename_tag did not apply the new name")

        _post_write(http, write_path, {"operation": "merge_tags", "source_tags": [tag_c], "target_tag": keep_tag}, ACK)
        merged_tags = _tag_names(_get_item(http, library_id, item_key))
        _require(tag_c not in merged_tags and keep_tag in merged_tags, "merge_tags did not fold the source into the target")

        # Item field and child-item operations.
        new_title = f"Live Smoke Retitled {suffix}"
        _post_write(http, write_path, {"operation": "update_item_fields", "item_key": item_key, "fields": {"title": new_title}}, ACK)
        _require(_get_item(http, library_id, item_key)["data"]["title"] == new_title, "update_item_fields did not persist the title")

        _post_write(
            http,
            write_path,
            {"operation": "update_attachment_title", "attachment_key": attachment_key, "new_title": "Live Smoke PDF Retitled"},
            ACK,
        )

        note_result = _post_write(
            http, write_path, {"operation": "attach_note", "parent_item_key": item_key, "note_text": "live smoke note"}, NOTE
        )
        note_key = note_result["note_key"]
        _post_write(http, write_path, {"operation": "update_note", "note_key": note_key, "new_content": "live smoke note updated"}, ACK)

        _post_write(
            http,
            write_path,
            {"operation": "attach_url", "parent_item_key": item_key, "url": "https://example.com/live-smoke"},
            ACK,
        )

        # Copy, then use the copy as the disposable side of merge/trash/restore.
        copy_key = _post_write(http, write_path, {"operation": "copy_item", "item_key": item_key}, COPY)["new_item_key"]
        created.append(copy_key)

        _post_write(http, write_path, {"operation": "trash_item", "item_key": copy_key}, ACK)
        _post_write(http, write_path, {"operation": "restore_item", "item_key": copy_key}, ACK)
        _require(_get_item(http, library_id, copy_key)["data"].get("deleted") is not True, "restore_item left the item trashed")

        _post_write(
            http,
            write_path,
            {"operation": "replace_item_json", "item_key": copy_key, "item_json": {"itemType": "journalArticle", "title": f"Live Smoke Replaced {suffix}"}},
            ACK,
        )
        _require(
            _get_item(http, library_id, copy_key)["data"]["title"] == f"Live Smoke Replaced {suffix}",
            "replace_item_json did not persist the replacement",
        )

        _post_write(http, write_path, {"operation": "merge_items", "source_key": copy_key, "target_key": item_key}, ACK)

        # Collection hierarchy operations, all on this run's own collections.
        parent_result = _post_write(
            http, write_path, {"operation": "create_collection", "name": f"live-smoke-parent-{suffix}"}, COLLECTION
        )
        parent_key = parent_result["details"]["collection_key"]

        _post_write(
            http,
            write_path,
            {"operation": "rename_collection", "collection_key": collection_key, "new_name": f"live-smoke-renamed-{suffix}"},
            ACK,
        )
        _post_write(
            http,
            write_path,
            {"operation": "move_collection", "collection_key": collection_key, "new_parent_key": parent_key},
            ACK,
        )
        _post_write(
            http,
            write_path,
            {"operation": "set_item_collections", "item_key": item_key, "collection_keys": [parent_key]},
            ACK,
        )
        _require(
            _get_item(http, library_id, item_key)["data"]["collections"] == [parent_key],
            "set_item_collections did not replace the collection set",
        )
        _post_write(
            http,
            write_path,
            {"operation": "merge_collections", "source_keys": [collection_key], "target_key": parent_key},
            ACK,
        )

        _post_write(http, write_path, {"operation": "trash_collection", "collection_key": parent_key}, ACK)

        standalone_keys = _prove_standalone_attach(http, write_path, attach_path, library_id, suffix, created)

        _post_write(http, write_path, {"operation": "trash_item", "item_key": item_key}, ACK)

        trashed_item = _wait_for_deleted(http, library_id, item_key)
        _require(
            trashed_item["data"].get("deleted") is True,
            f"trash_item did not mark the item deleted: {trashed_item!r}",
        )

        return {
            "success": True,
            "version": version_payload["version"],
            "item_key": item_key,
            "bibtex_item_key": bibtex_item_key,
            "attachment_key": attachment_key,
            "deleted_tag": doomed_tag,
            "kept_tag": keep_tag,
            "standalone_attachment_keys": standalone_keys,
        }
    finally:
        _trash_created(http, write_path, created)


def parse_args() -> SmokeArgs:
    parser = argparse.ArgumentParser(description="Run a live smoke proof against the local-write-api add-on.")
    parser.add_argument("--base-url", default="http://127.0.0.1:23119", help="Base URL for the local Zotero server")
    parser.add_argument("--library-id", default="0", help="Local Zotero library id for read-back checks")
    parser.add_argument("--expected-version", default="", help="Fail unless /version reports this exact add-on version")
    parser.add_argument(
        "--token",
        default="",
        help="Bearer token matching the running instance's localWriteAPI.token pref; "
        "when set, proves /write returns 401 without it and 400 with it",
    )
    return parser.parse_args(namespace=SmokeArgs())


def main() -> int:
    args = parse_args()
    # /attach uploads the PDF bytes inline, so the ceiling covers the slowest call.
    http = httpx.Client(
        base_url=args.base_url.rstrip("/"),
        headers={"Accept": "application/json"},
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
