#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "pyzotero>=1.5.0",
#     "requests>=2.30.0",
#     "PyMuPDF>=1.22.0",
#     "sentence-transformers>=2.2.0",
# ]
# ///
"""
Advanced Offline Pipeline Example

This script demonstrates an end-to-end offline processing pipeline combining Zotero's
native HTTP API with the local-write-api add-on and external Python libraries.

The pipeline performs the following steps on your Zotero library:
1. Connects to the local Zotero library using `pyzotero`.
2. Finds journal articles or preprints that have PDF attachments but no fulltext notes.
3. Retrieves the PDF file path directly from the local Zotero data directory.
4. Extracts the text content using `PyMuPDF`.
5. Generates semantic embeddings of the text using `sentence-transformers`.
6. Attaches the extracted text as a rich HTML note and adds an "embedded" tag to the
   item using `zotero-local-write-api`.

Note: This requires the zotero-local-write-api plugin to be installed in Zotero.
"""

from __future__ import annotations

import html
import os

import fitz  # PyMuPDF
import requests
from pyzotero import zotero
from sentence_transformers import SentenceTransformer

# Configuration for the Local Write API
ZOTERO_WRITE_API_URL = "http://localhost:23119/write"

# The local Zotero HTTP API only ever serves the single signed-in user library.
LOCAL_LIBRARY_ID = "0"
LOCAL_LIBRARY_TYPE = "user"
ZOTERO_DATA_DIR = os.path.expanduser("~/Zotero")


def get_local_zotero_client() -> zotero.Zotero:
    """Get authenticated Zotero client using the local API."""
    return zotero.Zotero(
        library_id=LOCAL_LIBRARY_ID,
        library_type=LOCAL_LIBRARY_TYPE,
        api_key=None,
        local=True,
    )


def has_fulltext_note(client: zotero.Zotero, item_key: str) -> bool:
    """Check if item already has a fulltext note attached."""
    children = client.children(item_key)
    for child in children:
        data = child["data"]
        if data["itemType"] == "note" and "Fulltext Content" in data["note"]:
            return True
    return False


def get_pdf_path(client: zotero.Zotero, item_key: str) -> str | None:
    """Find the absolute path to the best PDF attachment for an item.

    Returns None when the item genuinely has no stored PDF attachment on disk. Any
    error talking to Zotero or the filesystem propagates instead of being masked as
    "no PDF".
    """
    children = client.children(item_key)
    for child in children:
        data = child["data"]
        if (
            data["itemType"] == "attachment"
            and data.get("contentType") == "application/pdf"
        ):
            attachment_key = data["key"]
            # A PDF attachment without a filename has no resolvable on-disk path.
            if "filename" not in data:
                continue
            possible_path = os.path.join(
                ZOTERO_DATA_DIR, "storage", attachment_key, data["filename"]
            )
            if os.path.exists(possible_path):
                return possible_path
    return None


def extract_text(pdf_path: str) -> str:
    """Extract text from a PDF file using PyMuPDF."""
    text_parts: list[str] = []
    with fitz.open(pdf_path) as doc:
        for page in doc:
            text_parts.append(page.get_text())
    return "\n".join(text_parts) + "\n"


def generate_embedding(text_content: str, model: SentenceTransformer) -> list[float]:
    """Generate a vector embedding for the text using sentence-transformers."""
    # Truncate text context for embedding to fit typical context window of lightweight models
    truncated_text = text_content[:4000]
    embedding = model.encode(truncated_text)
    return embedding.tolist()


def update_zotero_item(item_key: str, text_content: str, tags: list[str]) -> None:
    """Tag the item and attach extracted text as a child note using the write API."""
    # 1. Add tags (performed first so partial failure doesn't result in skipped items)
    if tags:
        tag_payload = {
            "operation": "set_item_tags",
            "item_key": item_key,
            "tags": tags,
        }
        resp = requests.post(ZOTERO_WRITE_API_URL, json=tag_payload, timeout=5)
        resp.raise_for_status()

    # 2. Attach the note
    escaped_text = html.escape(text_content[:2000])
    note_html = f"<h1>Fulltext Content</h1><p><pre>{escaped_text}... (truncated)</pre></p>"
    attach_payload = {
        "operation": "attach_note",
        "parent_item_key": item_key,
        "note_text": note_html,
        "title": "Fulltext Content",
    }
    resp = requests.post(ZOTERO_WRITE_API_URL, json=attach_payload, timeout=5)
    resp.raise_for_status()


def main() -> None:
    print("Initializing offline processing pipeline...")
    client = get_local_zotero_client()

    print("Loading embedding model (this may take a moment)...")
    model = SentenceTransformer("all-MiniLM-L6-v2")

    print("Fetching items from Zotero...")
    items = client.items(limit=30)
    processed_count = 0

    for item in items:
        data = item["data"]
        item_key = data["key"]
        title = data["title"]
        item_type = data["itemType"]

        # Only process standard items that might have PDFs
        if item_type in ["attachment", "note", "artwork", "computerProgram"]:
            continue

        print(f"\nProcessing {item_key}: {title[:50]}...")

        if has_fulltext_note(client, item_key):
            print("  -> Already has fulltext note. Skipping.")
            continue

        pdf_path = get_pdf_path(client, item_key)
        if pdf_path is None:
            print("  -> No PDF attachment found.")
            continue

        print(f"  -> Found PDF at: {pdf_path}")

        print("  -> Extracting text with PyMuPDF...")
        text_content = extract_text(pdf_path)
        if not text_content.strip():
            print("  -> Text extraction produced empty output.")
            continue

        print("  -> Generating semantic embedding via sentence-transformers...")
        embedding = generate_embedding(text_content, model)
        # Here you would typically save the embedding to a vector database (e.g. ChromaDB).
        # We skip the DB insertion to keep the example focused.

        print("  -> Updating Zotero item via Local Write API...")
        existing_tags = [t["tag"] for t in data["tags"]]
        tags_to_set: list[str] = []
        if embedding:
            tags_to_set = list(set(existing_tags + ["embedded", "fulltext-extracted"]))

        update_zotero_item(item_key, text_content, tags=tags_to_set)
        print("  [OK] Extracted text attached and tags updated successfully!")
        processed_count += 1

    print(f"\nPipeline complete. Processed {processed_count} new items.")


if __name__ == "__main__":
    main()
