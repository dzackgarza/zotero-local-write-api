#!/usr/bin/env python3
"""
Live smoke proof for the local-write-api add-on.

This script exercises the add-on against a real running Zotero instance:
- version probe
- create_item
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
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any
from uuid import uuid4


PDF_BYTES = (
    b"%PDF-1.4\n"
    b"%live-smoke-proof\n"
    b"1 0 obj\n<<>>\nendobj\n"
    b"trailer\n<<>>\n%%EOF\n"
)


class SmokeFailure(RuntimeError):
    """Raised when the live smoke proof fails."""


def _request_json(method: str, url: str, payload: dict[str, Any] | None = None, timeout: float = 30.0) -> Any:
    headers = {"Accept": "application/json"}
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


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise SmokeFailure(message)


def _tag_names(item: dict[str, Any]) -> list[str]:
    return [
        tag.get("tag", "").strip()
        for tag in item.get("data", {}).get("tags", [])
        if isinstance(tag, dict) and tag.get("tag", "").strip()
    ]


def _get_item(base_url: str, library_id: str, item_key: str) -> dict[str, Any]:
    quoted_key = urllib.parse.quote(item_key)
    return _request_json("GET", f"{base_url}/api/users/{library_id}/items/{quoted_key}")


def _get_children(base_url: str, library_id: str, item_key: str) -> list[dict[str, Any]]:
    quoted_key = urllib.parse.quote(item_key)
    children = _request_json("GET", f"{base_url}/api/users/{library_id}/items/{quoted_key}/children")
    _require(isinstance(children, list), f"Expected children list for item {item_key}, got: {children!r}")
    return children


def _post_write(base_url: str, write_path: str, payload: dict[str, Any]) -> dict[str, Any]:
    result = _request_json("POST", f"{base_url}{write_path}", payload=payload)
    _require(isinstance(result, dict), f"Expected object response from {write_path}, got: {result!r}")
    return result


def _post_attach(base_url: str, attach_path: str, payload: dict[str, Any]) -> dict[str, Any]:
    result = _request_json("POST", f"{base_url}{attach_path}", payload=payload, timeout=60.0)
    _require(isinstance(result, dict), f"Expected object response from {attach_path}, got: {result!r}")
    return result


def _wait_for_deleted(base_url: str, library_id: str, item_key: str, *, timeout: float = 5.0, interval: float = 0.25) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while True:
        item = _get_item(base_url, library_id, item_key)
        if bool(item.get("data", {}).get("deleted")):
            return item
        if time.monotonic() >= deadline:
            return item
        time.sleep(interval)


def _cleanup_item(base_url: str, write_path: str, item_key: str | None) -> None:
    if not item_key:
        return
    try:
        _post_write(
            base_url,
            write_path,
            {"operation": "trash_item", "item_key": item_key},
        )
    except Exception:
        pass


def run(args: argparse.Namespace) -> dict[str, Any]:
    base_url = args.base_url.rstrip("/")
    library_id = str(args.library_id)
    suffix = uuid4().hex[:10]
    doomed_tag = f"live-smoke-delete-{suffix}"
    keep_tag = f"live-smoke-keep-{suffix}"
    item_key: str | None = None
    write_path = ""

    version_payload = _request_json("GET", f"{base_url}/version")
    _require(isinstance(version_payload, dict), f"Expected version payload object, got: {version_payload!r}")
    _require(version_payload.get("success") is True, f"Version probe failed: {version_payload!r}")
    if args.expected_version:
        _require(
            version_payload.get("version") == args.expected_version,
            f"Expected add-on version {args.expected_version}, got {version_payload.get('version')!r}",
        )

    endpoints = version_payload.get("endpoints", {})
    _require(isinstance(endpoints, dict), f"Version probe did not include endpoints: {version_payload!r}")
    attach_path = endpoints.get("attach")
    write_path = endpoints.get("write")
    _require(isinstance(attach_path, str) and attach_path.startswith("/"), f"Invalid attach endpoint: {attach_path!r}")
    _require(isinstance(write_path, str) and write_path.startswith("/"), f"Invalid write endpoint: {write_path!r}")

    capabilities = version_payload.get("capabilities", [])
    _require(isinstance(capabilities, list), f"Version probe did not include capabilities list: {version_payload!r}")
    for capability in ("attach", "attach_bytes", "write", "version_probe"):
        _require(capability in capabilities, f"Missing required capability {capability!r}: {capabilities!r}")

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
        _require(created_item.get("data", {}).get("title") == f"live-smoke-item-{suffix}", f"Unexpected item title: {created_item!r}")
        created_tags = set(_tag_names(created_item))
        _require(created_tags == {doomed_tag, keep_tag}, f"Unexpected initial tags: {created_tags!r}")

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
        attach_details = attach_result.get("details", {})
        _require(attach_details.get("source_mode") == "bytes", f"Expected bytes source_mode, got: {attach_result!r}")

        children = _get_children(base_url, library_id, item_key)
        matching_attachment = next((child for child in children if child.get("key") == attachment_key), None)
        _require(matching_attachment is not None, f"Attached PDF {attachment_key} not found in children: {children!r}")
        _require(
            matching_attachment.get("data", {}).get("contentType") == "application/pdf",
            f"Attachment contentType mismatch: {matching_attachment!r}",
        )
        _require(
            matching_attachment.get("data", {}).get("title") == "Live Smoke PDF",
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

        trash_result = _post_write(
            base_url,
            write_path,
            {"operation": "trash_item", "item_key": item_key},
        )
        _require(trash_result.get("success") is True, f"trash_item failed: {trash_result!r}")

        trashed_item = _wait_for_deleted(base_url, library_id, item_key)
        _require(
            bool(trashed_item.get("data", {}).get("deleted")) is True,
            f"trash_item did not mark the item deleted: {trashed_item!r}",
        )

        return {
            "success": True,
            "version": version_payload.get("version"),
            "item_key": item_key,
            "attachment_key": attachment_key,
            "deleted_tag": doomed_tag,
            "kept_tag": keep_tag,
        }
    finally:
        _cleanup_item(base_url, write_path, item_key)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a live smoke proof against the local-write-api add-on.")
    parser.add_argument("--base-url", default="http://127.0.0.1:23119", help="Base URL for the local Zotero server")
    parser.add_argument("--library-id", default="0", help="Local Zotero library id for read-back checks")
    parser.add_argument("--expected-version", default="", help="Fail unless /version reports this exact add-on version")
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
