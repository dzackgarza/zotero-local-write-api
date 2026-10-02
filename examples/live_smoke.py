#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
Live smoke proof for the local-write-api add-on.

This script exercises the add-on against a real running Zotero instance:
- version probe
- create_item
- import_bibtex
- byte-backed PDF attach
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
import urllib.error
import urllib.parse
import urllib.request
from typing import Any
from uuid import uuid4

TOKEN_PREF = "extensions.zotero.localWriteAPI.token"


PDF_BYTES = (
    b"%PDF-1.4\n"
    b"%live-smoke-proof\n"
    b"1 0 obj\n<<>>\nendobj\n"
    b"trailer\n<<>>\n%%EOF\n"
)


class SmokeFailure(RuntimeError):
    """Raised when the live smoke proof fails."""


def _request_json(
    method: str,
    url: str,
    payload: dict[str, Any] | None = None,
    timeout: float = 30.0,
    auth_headers: dict[str, str] | None = None,
) -> Any:
    headers = {"Accept": "application/json", **(auth_headers or {})}
    body = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        raise SmokeFailure(f"{method} {url} returned HTTP {exc.code}: {raw}") from exc
    except urllib.error.URLError as exc:
        raise SmokeFailure(f"{method} {url} failed: {exc.reason}") from exc
    except ConnectionError as exc:
        raise SmokeFailure(f"{method} {url} failed: {exc}") from exc

    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SmokeFailure(f"{method} {url} did not return JSON: {raw}") from exc


def _request_status(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    payload: dict[str, Any] | None = None,
    timeout: float = 30.0,
) -> tuple[int, str]:
    """Return (status_code, body_text). Does not raise on 4xx/5xx."""
    request_headers = dict(headers or {})
    body = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        request_headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=body, headers=request_headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", errors="replace")
    except urllib.error.URLError as exc:
        raise SmokeFailure(f"{method} {url} failed: {exc.reason}") from exc


def _prove_openapi_endpoint(base_url: str, write_path: str) -> None:
    """GET /openapi.yaml serves the bundled schema as a public document."""
    status, body = _request_status("GET", f"{base_url}/openapi.yaml")
    _require(status == 200, f"/openapi.yaml returned HTTP {status}, expected 200: {body[:200]!r}")
    _require(body.startswith("openapi:"), f"/openapi.yaml body is not an OpenAPI doc: {body[:80]!r}")
    _require(
        f"{write_path}:" in body,
        f"/openapi.yaml does not describe the {write_path} path: {body[:200]!r}",
    )


def _prove_bearer_auth(base_url: str, write_path: str, token: str) -> None:
    """With the token pref set, /write demands a matching bearer token.

    Auth is checked before the request body, so an empty body isolates the gate:
    no token -> 401; correct token -> the body-validation 400, never 401. This
    proves the gate without creating or trashing any library item.
    """
    no_token_status, no_token_body = _request_status("POST", f"{base_url}{write_path}", payload={})
    _require(
        no_token_status == 401,
        f"/write without a token returned HTTP {no_token_status}, expected 401: {no_token_body[:200]!r}",
    )
    good_status, good_body = _request_status(
        "POST",
        f"{base_url}{write_path}",
        headers={"Authorization": f"Bearer {token}"},
        payload={},
    )
    _require(
        good_status == 400,
        f"/write with the token returned HTTP {good_status}, expected 400 (body validation): {good_body[:200]!r}",
    )
    wrong_status, wrong_body = _request_status(
        "POST",
        f"{base_url}{write_path}",
        headers={"Authorization": "Bearer not-the-token"},
        payload={},
    )
    _require(
        wrong_status == 401,
        f"/write with a wrong token returned HTTP {wrong_status}, expected 401: {wrong_body[:200]!r}",
    )


def _run_javascript(
    base_url: str, write_path: str, code: str, auth_headers: dict[str, str] | None = None
) -> Any:
    result = _request_json(
        "POST",
        f"{base_url}{write_path}",
        payload={"operation": "run_javascript", "code": code},
        auth_headers=auth_headers,
    )
    _require(
        isinstance(result, dict) and result.get("success") is True,
        f"run_javascript failed: {result!r}",
    )
    return result["details"]["result"]


def _prove_bearer_gate(base_url: str, write_path: str, token: str) -> None:
    """Always exercise the bearer gate, self-provisioning when no token is given.

    With an externally-set token (--token), prove against it directly. Otherwise
    set a random token through the open loopback run_javascript op, prove the
    gate, then clear it so the caller's default loopback-open state is restored.
    """
    if token:
        _prove_bearer_auth(base_url, write_path, token)
        return
    open_status, _ = _request_status("POST", f"{base_url}{write_path}", payload={})
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
        base_url, write_path, f"Zotero.Prefs.set({TOKEN_PREF!r}, {probe_token!r}, true); return true;"
    )
    auth = {"Authorization": f"Bearer {probe_token}"}
    try:
        _prove_bearer_auth(base_url, write_path, probe_token)
    finally:
        _run_javascript(
            base_url,
            write_path,
            f"Zotero.Prefs.clear({TOKEN_PREF!r}, true); return true;",
            auth_headers=auth,
        )

    # The published-without-token deny branch (publicBaseURL set, token unset) is NOT
    # proved here on purpose. Reaching that state means /write denies every request,
    # including the run_javascript needed to clear either pref, so a proof that entered
    # it could not get back out and would leave the instance unusable. Proving it needs
    # a disposable profile, not the operator's own.


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise SmokeFailure(message)


def _tag_names(item: dict[str, Any]) -> list[str]:
    return [
        tag["tag"].strip()
        for tag in item["data"]["tags"]
        if tag["tag"].strip()
    ]


def _get_item(base_url: str, library_id: str, item_key: str) -> dict[str, Any]:
    quoted_key = urllib.parse.quote(item_key)
    return _request_json("GET", f"{base_url}/api/users/{library_id}/items/{quoted_key}")


def _get_children(base_url: str, library_id: str, item_key: str) -> list[dict[str, Any]]:
    quoted_key = urllib.parse.quote(item_key)
    children = _request_json("GET", f"{base_url}/api/users/{library_id}/items/{quoted_key}/children")
    _require(isinstance(children, list), f"Expected children list for item {item_key}, got: {children!r}")
    return children


# Bearer header applied to every /write and /attach call, populated by run()
# from --token. When the instance's token pref is set, the item-lifecycle calls
# must authenticate too, not just the dedicated gate proof.
_WRITE_AUTH: dict[str, str] = {}


def _post_write(base_url: str, write_path: str, payload: dict[str, Any]) -> dict[str, Any]:
    result = _request_json("POST", f"{base_url}{write_path}", payload=payload, auth_headers=_WRITE_AUTH)
    _require(isinstance(result, dict), f"Expected object response from {write_path}, got: {result!r}")
    return result


def _post_attach(base_url: str, attach_path: str, payload: dict[str, Any]) -> dict[str, Any]:
    result = _request_json(
        "POST", f"{base_url}{attach_path}", payload=payload, timeout=60.0, auth_headers=_WRITE_AUTH
    )
    _require(isinstance(result, dict), f"Expected object response from {attach_path}, got: {result!r}")
    return result


def _wait_for_deleted(base_url: str, library_id: str, item_key: str, *, timeout: float = 5.0, interval: float = 0.25) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while True:
        item = _get_item(base_url, library_id, item_key)
        if bool(item["data"].get("deleted")):
            return item
        if time.monotonic() >= deadline:
            return item
        time.sleep(interval)


def _cleanup_item(base_url: str, write_path: str, item_key: str | None) -> None:
    if not item_key:
        return
    _post_write(
        base_url,
        write_path,
        {"operation": "trash_item", "item_key": item_key},
    )


def run(args: argparse.Namespace) -> dict[str, Any]:
    if args.token:
        _WRITE_AUTH["Authorization"] = f"Bearer {args.token}"
    base_url = args.base_url.rstrip("/")
    library_id = str(args.library_id)
    suffix = uuid4().hex[:10]
    doomed_tag = f"live-smoke-delete-{suffix}"
    keep_tag = f"live-smoke-keep-{suffix}"
    item_key: str | None = None
    bibtex_item_key: str | None = None
    write_path = ""

    version_payload = _request_json("GET", f"{base_url}/version")
    _require(isinstance(version_payload, dict), f"Expected version payload object, got: {version_payload!r}")
    _require(version_payload.get("success") is True, f"Version probe failed: {version_payload!r}")
    if args.expected_version:
        _require(
            version_payload.get("version") == args.expected_version,
            f"Expected add-on version {args.expected_version}, got {version_payload.get('version')!r}",
        )

    _require("endpoints" in version_payload, f"Version probe did not include endpoints: {version_payload!r}")
    endpoints = version_payload["endpoints"]
    _require(isinstance(endpoints, dict), f"Version probe endpoints is not an object: {version_payload!r}")
    attach_path = endpoints.get("attach")
    write_path = endpoints.get("write")
    _require(isinstance(attach_path, str) and attach_path.startswith("/"), f"Invalid attach endpoint: {attach_path!r}")
    _require(isinstance(write_path, str) and write_path.startswith("/"), f"Invalid write endpoint: {write_path!r}")

    _require("capabilities" in version_payload, f"Version probe did not include capabilities: {version_payload!r}")
    capabilities = version_payload["capabilities"]
    _require(isinstance(capabilities, list), f"Version probe capabilities is not a list: {version_payload!r}")
    for capability in ("attach", "attach_bytes", "write", "version_probe", "import_bibtex"):
        _require(capability in capabilities, f"Missing required capability {capability!r}: {capabilities!r}")

    _prove_openapi_endpoint(base_url, write_path)
    # Always prove the bearer gate: with --token against a pre-authed instance,
    # otherwise self-provisioning a throwaway token and clearing it after.
    _prove_bearer_gate(base_url, write_path, args.token)

    try:
        create_result = _post_write(
            base_url,
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
        )
        _require(create_result.get("success") is True, f"create_item failed: {create_result!r}")
        item_key = create_result.get("item_key")
        _require(isinstance(item_key, str) and item_key, f"create_item did not return item_key: {create_result!r}")

        created_item = _get_item(base_url, library_id, item_key)
        _require(created_item["data"]["title"] == f"live-smoke-item-{suffix}", f"Unexpected item title: {created_item!r}")
        created_tags = set(_tag_names(created_item))
        _require(created_tags == {doomed_tag, keep_tag}, f"Unexpected initial tags: {created_tags!r}")

        bibtex_title = f"live-smoke-bibtex-{suffix}"
        bibtex_result = _post_write(
            base_url,
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
        )
        _require(bibtex_result.get("success") is True, f"import_bibtex failed: {bibtex_result!r}")
        bibtex_item_key = bibtex_result.get("item_key")
        _require(isinstance(bibtex_item_key, str) and bibtex_item_key, f"import_bibtex did not return item_key: {bibtex_result!r}")
        bibtex_item = _get_item(base_url, library_id, bibtex_item_key)
        _require(
            bibtex_item["data"]["title"] == bibtex_title,
            f"import_bibtex read-back title mismatch: {bibtex_item!r}",
        )

        attach_result = _post_attach(
            base_url,
            attach_path,
            {
                "item_key": item_key,
                "title": "Live Smoke PDF",
                "file_name": "live-smoke.pdf",
                "file_bytes_base64": base64.b64encode(PDF_BYTES).decode("ascii"),
            },
        )
        _require(attach_result.get("success") is True, f"/attach failed: {attach_result!r}")
        attachment_key = attach_result.get("attachment_key")
        _require(isinstance(attachment_key, str) and attachment_key, f"Missing attachment_key: {attach_result!r}")
        _require("details" in attach_result, f"/attach response missing details: {attach_result!r}")
        attach_details = attach_result["details"]
        _require(attach_details["source_mode"] == "bytes", f"Expected bytes source_mode, got: {attach_result!r}")

        children = _get_children(base_url, library_id, item_key)
        matching_attachment = next((child for child in children if child.get("key") == attachment_key), None)
        _require(matching_attachment is not None, f"Attached PDF {attachment_key} not found in children: {children!r}")
        _require(
            matching_attachment["data"]["contentType"] == "application/pdf",
            f"Attachment contentType mismatch: {matching_attachment!r}",
        )
        _require(
            matching_attachment["data"]["title"] == "Live Smoke PDF",
            f"Attachment title mismatch: {matching_attachment!r}",
        )

        delete_tag_result = _post_write(
            base_url,
            write_path,
            {"operation": "delete_tag", "tag_name": doomed_tag},
        )
        _require(delete_tag_result.get("success") is True, f"delete_tag failed: {delete_tag_result!r}")

        updated_item = _get_item(base_url, library_id, item_key)
        updated_tags = set(_tag_names(updated_item))
        _require(doomed_tag not in updated_tags, f"delete_tag left doomed tag behind: {updated_tags!r}")
        _require(keep_tag in updated_tags, f"delete_tag removed the keep tag: {updated_tags!r}")

        # Collection round-trip. Both handlers map an item's collection IDs back to
        # keys through Zotero.Collections.get, whose documented `false` sentinel was
        # dereferenced directly; nothing exercised that path at the real boundary.
        collection_name = f"live-smoke-collection-{suffix}"
        create_collection_result = _post_write(
            base_url,
            write_path,
            {"operation": "create_collection", "name": collection_name},
        )
        _require(
            create_collection_result.get("success") is True,
            f"create_collection failed: {create_collection_result!r}",
        )
        collection_key = create_collection_result["details"]["collection_key"]

        add_result = _post_write(
            base_url,
            write_path,
            {
                "operation": "add_item_to_collection",
                "item_key": item_key,
                "collection_key": collection_key,
            },
        )
        _require(add_result.get("success") is True, f"add_item_to_collection failed: {add_result!r}")
        _require(
            collection_key in _get_item(base_url, library_id, item_key)["data"]["collections"],
            "add_item_to_collection did not attach the collection",
        )

        remove_result = _post_write(
            base_url,
            write_path,
            {
                "operation": "remove_item_from_collection",
                "item_key": item_key,
                "collection_key": collection_key,
            },
        )
        _require(
            remove_result.get("success") is True,
            f"remove_item_from_collection failed: {remove_result!r}",
        )
        _require(
            collection_key not in _get_item(base_url, library_id, item_key)["data"]["collections"],
            "remove_item_from_collection left the collection attached",
        )

        # Tag operations, all scoped to this run's own tags.
        tag_a = f"live-smoke-a-{suffix}"
        tag_b = f"live-smoke-b-{suffix}"
        tag_c = f"live-smoke-c-{suffix}"

        _require(
            _post_write(base_url, write_path, {"operation": "add_item_tags", "item_key": item_key, "tags": [tag_a]}).get("success") is True,
            "add_item_tags failed",
        )
        _require(tag_a in _tag_names(_get_item(base_url, library_id, item_key)), "add_item_tags did not add the tag")

        _require(
            _post_write(base_url, write_path, {"operation": "set_item_tags", "item_key": item_key, "tags": [keep_tag, tag_a, tag_b]}).get("success") is True,
            "set_item_tags failed",
        )
        _require(set(_tag_names(_get_item(base_url, library_id, item_key))) == {keep_tag, tag_a, tag_b}, "set_item_tags did not replace the tag set")

        _require(
            _post_write(base_url, write_path, {"operation": "remove_item_tags", "item_key": item_key, "tags": [tag_b]}).get("success") is True,
            "remove_item_tags failed",
        )
        _require(tag_b not in _tag_names(_get_item(base_url, library_id, item_key)), "remove_item_tags left the tag attached")

        _require(
            _post_write(base_url, write_path, {"operation": "rename_tag", "old_name": tag_a, "new_name": tag_c}).get("success") is True,
            "rename_tag failed",
        )
        _require(tag_c in _tag_names(_get_item(base_url, library_id, item_key)), "rename_tag did not apply the new name")

        _require(
            _post_write(base_url, write_path, {"operation": "merge_tags", "source_tags": [tag_c], "target_tag": keep_tag}).get("success") is True,
            "merge_tags failed",
        )
        merged_tags = _tag_names(_get_item(base_url, library_id, item_key))
        _require(tag_c not in merged_tags and keep_tag in merged_tags, "merge_tags did not fold the source into the target")

        # Item field and child-item operations.
        new_title = f"Live Smoke Retitled {suffix}"
        _require(
            _post_write(base_url, write_path, {"operation": "update_item_fields", "item_key": item_key, "fields": {"title": new_title}}).get("success") is True,
            "update_item_fields failed",
        )
        _require(_get_item(base_url, library_id, item_key)["data"]["title"] == new_title, "update_item_fields did not persist the title")

        _require(
            _post_write(base_url, write_path, {"operation": "update_attachment_title", "attachment_key": attachment_key, "new_title": "Live Smoke PDF Retitled"}).get("success") is True,
            "update_attachment_title failed",
        )

        note_result = _post_write(base_url, write_path, {"operation": "attach_note", "parent_item_key": item_key, "note_text": "live smoke note"})
        _require(note_result.get("success") is True, f"attach_note failed: {note_result!r}")
        note_key = note_result["note_key"]
        _require(
            _post_write(base_url, write_path, {"operation": "update_note", "note_key": note_key, "new_content": "live smoke note updated"}).get("success") is True,
            "update_note failed",
        )

        url_result = _post_write(base_url, write_path, {"operation": "attach_url", "parent_item_key": item_key, "url": "https://example.com/live-smoke"})
        _require(url_result.get("success") is True, f"attach_url failed: {url_result!r}")

        # Copy, then use the copy as the disposable side of merge/trash/restore.
        copy_result = _post_write(base_url, write_path, {"operation": "copy_item", "item_key": item_key})
        _require(copy_result.get("success") is True, f"copy_item failed: {copy_result!r}")
        copy_key = copy_result["new_item_key"]

        _require(
            _post_write(base_url, write_path, {"operation": "trash_item", "item_key": copy_key}).get("success") is True,
            "trash_item on the copy failed",
        )
        _require(
            _post_write(base_url, write_path, {"operation": "restore_item", "item_key": copy_key}).get("success") is True,
            "restore_item failed",
        )
        _require(_get_item(base_url, library_id, copy_key)["data"].get("deleted") is not True, "restore_item left the item trashed")

        _require(
            _post_write(base_url, write_path, {"operation": "replace_item_json", "item_key": copy_key, "item_json": {"itemType": "journalArticle", "title": f"Live Smoke Replaced {suffix}"}}).get("success") is True,
            "replace_item_json failed",
        )
        _require(
            _get_item(base_url, library_id, copy_key)["data"]["title"] == f"Live Smoke Replaced {suffix}",
            "replace_item_json did not persist the replacement",
        )

        _require(
            _post_write(base_url, write_path, {"operation": "merge_items", "source_key": copy_key, "target_key": item_key}).get("success") is True,
            "merge_items failed",
        )

        # Collection hierarchy operations, all on this run's own collections.
        parent_result = _post_write(base_url, write_path, {"operation": "create_collection", "name": f"live-smoke-parent-{suffix}"})
        _require(parent_result.get("success") is True, f"create_collection (parent) failed: {parent_result!r}")
        parent_key = parent_result["details"]["collection_key"]

        _require(
            _post_write(base_url, write_path, {"operation": "rename_collection", "collection_key": collection_key, "new_name": f"live-smoke-renamed-{suffix}"}).get("success") is True,
            "rename_collection failed",
        )
        _require(
            _post_write(base_url, write_path, {"operation": "move_collection", "collection_key": collection_key, "new_parent_key": parent_key}).get("success") is True,
            "move_collection failed",
        )
        _require(
            _post_write(base_url, write_path, {"operation": "set_item_collections", "item_key": item_key, "collection_keys": [parent_key]}).get("success") is True,
            "set_item_collections failed",
        )
        _require(
            _get_item(base_url, library_id, item_key)["data"]["collections"] == [parent_key],
            "set_item_collections did not replace the collection set",
        )
        _require(
            _post_write(base_url, write_path, {"operation": "merge_collections", "source_keys": [collection_key], "target_key": parent_key}).get("success") is True,
            "merge_collections failed",
        )

        _post_write(base_url, write_path, {"operation": "trash_collection", "collection_key": parent_key})

        trash_result = _post_write(
            base_url,
            write_path,
            {"operation": "trash_item", "item_key": item_key},
        )
        _require(trash_result.get("success") is True, f"trash_item failed: {trash_result!r}")

        trashed_item = _wait_for_deleted(base_url, library_id, item_key)
        _require(
            bool(trashed_item["data"].get("deleted")) is True,
            f"trash_item did not mark the item deleted: {trashed_item!r}",
        )

        return {
            "success": True,
            "version": version_payload.get("version"),
            "item_key": item_key,
            "bibtex_item_key": bibtex_item_key,
            "attachment_key": attachment_key,
            "deleted_tag": doomed_tag,
            "kept_tag": keep_tag,
        }
    finally:
        _cleanup_item(base_url, write_path, bibtex_item_key)
        _cleanup_item(base_url, write_path, item_key)


def parse_args() -> argparse.Namespace:
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
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        result = run(args)
    except SmokeFailure as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
