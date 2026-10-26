#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "pyzotero>=1.5.0",
# ]
# ///
"""
Find Zotero item by BibTeX key.

This example script demonstrates how to locate a Zotero item in your local library
by searching for its Better BibTeX citation key using the standard pyzotero library.
"""

from __future__ import annotations

import sys

from pyzotero import zotero

# The local Zotero HTTP API only ever serves the single signed-in user library.
LOCAL_LIBRARY_ID = "0"
LOCAL_LIBRARY_TYPE = "user"


def get_local_zotero_client() -> zotero.Zotero:
    """Get authenticated Zotero client using the local API."""
    return zotero.Zotero(
        library_id=LOCAL_LIBRARY_ID,
        library_type=LOCAL_LIBRARY_TYPE,
        api_key=None,  # Not needed for local API
        local=True,  # Force local mode
    )


def creator_name(creator: dict) -> str:
    """Render a Zotero creator as a display name.

    Zotero stores creators either as a two-field person (firstName/lastName) or as a
    single-field institution (name). Anything else is a contract violation and must
    crash rather than silently render an empty string.
    """
    if "name" in creator:
        return creator["name"].strip()
    has_first = "firstName" in creator
    has_last = "lastName" in creator
    if not (has_first or has_last):
        raise KeyError(
            f"creator has neither name nor firstName/lastName: {creator!r}"
        )
    first = creator["firstName"] if has_first else ""
    last = creator["lastName"] if has_last else ""
    return f"{first} {last}".strip()


def check_items(item_list: list[dict], target_key: str) -> bool:
    for item in item_list:
        data = item["data"]
        # Better BibTeX citation keys are stored in the citationKey field; an item
        # without one simply cannot match the requested key.
        if "citationKey" not in data:
            continue
        if data["citationKey"] == target_key:
            print(f"\nFound item with BibTeX key '{target_key}':")
            print(f"  Item Key: {data['key']}")
            print(f"  Title: {data['title']}")
            authors = ", ".join(creator_name(c) for c in data["creators"])
            print(f"  Authors: {authors}")
            print(f"  Year: {data['date']}")
            print(f"  Item Type: {data['itemType']}")
            return True
    return False


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python find_item_by_bibtex.py <bibtex_key>")
        print("Example: python find_item_by_bibtex.py Ale22")
        sys.exit(1)

    target_key = sys.argv[1]
    client = get_local_zotero_client()

    print(f"Searching for BibTeX key: {target_key}")

    # Fetch items in batches (limit=100)
    items = client.items(limit=100)
    found = check_items(items, target_key)

    if not found:
        print("Not found in first 100 items, searching all items...")
        all_items = client.everything(client.items())
        found = check_items(all_items, target_key)

    if not found:
        print(f"\nNo item found with BibTeX key '{target_key}'")


if __name__ == "__main__":
    main()
