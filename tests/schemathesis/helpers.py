"""Shared live HTTP and read-back helpers for the Schemathesis proofs.

These talk to a real running Zotero: the add-on's write endpoints plus
Zotero's built-in read-only local API for independent read-back. No mocks,
no client-repo code. Kept deliberately small rather than importing the
standalone ``examples/live_smoke.py`` script wholesale.
"""

from __future__ import annotations

import json
import os
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


DEFAULT_BASE_URL = "http://127.0.0.1:23119"


def base_url() -> str:
    return os.environ.get("ZOTERO_LOCAL_BASE_URL", DEFAULT_BASE_URL).rstrip("/")


def library_id() -> str:
    return str(os.environ.get("ZOTERO_LIBRARY_ID", "0"))


def request_json(
    method: str,
    url: str,
    payload: dict[str, Any] | None = None,
    timeout: float = 30.0,
) -> Any:
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
        raise HttpError(exc.code, raw) from exc
    return json.loads(raw)


class HttpError(RuntimeError):
    def __init__(self, status: int, body: str) -> None:
        super().__init__(f"HTTP {status}: {body}")
        self.status = status
        self.body = body


def write_path() -> str:
    return f"{base_url()}/write"


def post_write(payload: dict[str, Any]) -> dict[str, Any]:
    result = request_json("POST", write_path(), payload=payload)
    if not isinstance(result, dict):
        raise RuntimeError(f"Expected object from /write, got: {result!r}")
    return result


def get_item(item_key: str) -> dict[str, Any]:
    quoted = urllib.parse.quote(item_key)
    return request_json("GET", f"{base_url()}/api/users/{library_id()}/items/{quoted}")


def get_children(item_key: str) -> list[dict[str, Any]]:
    quoted = urllib.parse.quote(item_key)
    children = request_json(
        "GET", f"{base_url()}/api/users/{library_id()}/items/{quoted}/children"
    )
    if not isinstance(children, list):
        raise RuntimeError(f"Expected children list for {item_key}, got: {children!r}")
    return children


def nfc(value: str) -> str:
    """Normalize text the way Zotero stores it.

    Zotero NFC-normalizes item field values and tag names on write, so a
    read-back is equal to ``NFC(sent)``, not to the bytes sent. Verified live
    against Zotero 8.0.1 over titles and tags for decomposed sequences
    (``e`` + U+0301 -> U+00E9), singleton mappings (U+212B -> U+00C5), and
    composition exclusions where NFC decomposes the input (U+0A33 -> U+0A32
    U+0A3C); NFD and byte-identity were both falsified.

    So round-trip assertions compare NFC forms. That is the real contract:
    asserting byte-identity would assert a promise Zotero does not make.
    """
    return unicodedata.normalize("NFC", value)


def tag_names(item: dict[str, Any]) -> set[str]:
    """The item's tag names, NFC-normalized to match Zotero's own storage."""
    return {
        nfc(tag["tag"].strip())
        for tag in item["data"].get("tags", [])
        if tag["tag"].strip()
    }


def is_deleted(item_key: str) -> bool:
    return bool(get_item(item_key)["data"].get("deleted"))


def wait_for(predicate, *, timeout: float = 5.0, interval: float = 0.25) -> bool:
    deadline = time.monotonic() + timeout
    while True:
        if predicate():
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(interval)


def trash_item(item_key: str) -> None:
    """Trash an item. Idempotent: re-trashing an already-trashed item succeeds."""
    post_write({"operation": "trash_item", "item_key": item_key})


def trash_collection(collection_key: str) -> None:
    post_write({"operation": "trash_collection", "collection_key": collection_key})
