#!/usr/bin/env python3
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

Requirements:
    pip install -r requirements.txt
    (Depends on pyzotero, requests, PyMuPDF, sentence-transformers)

Note: This requires the zotero-local-write-api plugin to be installed in Zotero.
"""

import os
import sys
import html
from pathlib import Path

try:
    import requests
    from pyzotero import zotero
    import fitz  # PyMuPDF
    from sentence_transformers import SentenceTransformer
except ImportError:
    print("Missing dependencies. Please run: pip install -r requirements.txt")
    sys.exit(1)

# Configuration for the Local Write API
ZOTERO_WRITE_API_URL = "http://localhost:23119/write"

def get_local_zotero_client() -> zotero.Zotero:
    """Get authenticated Zotero client using the local API."""
    library_id = os.getenv("ZOTERO_LIBRARY_ID", "0")
    library_type = os.getenv("ZOTERO_LIBRARY_TYPE", "user")

    return zotero.Zotero(
        library_id=library_id,
        library_type=library_type,
        api_key=None,
        local=True,
    )

def has_fulltext_note(client: zotero.Zotero, item_key: str) -> bool:
    """Check if item already has a fulltext note attached."""
    try:
        children = client.children(item_key)
        for child in children:
            if (
                child.get("data", {}).get("itemType") == "note"
                and "Fulltext Content" in child.get("data", {}).get("note", "")
            ):
                return True
    except Exception as e:
        print(f"Error checking children for {item_key}: {e}")
    return False

def get_pdf_path(client: zotero.Zotero, item_key: str) -> str:
    """Find the absolute path to the best PDF attachment for an item."""
    try:
        children = client.children(item_key)
        for child in children:
            data = child.get("data", {})
            if data.get("itemType") == "attachment" and data.get("contentType") == "application/pdf":
                attachment_key = data.get("key")
                filename = data.get("filename")
                if not filename:
                    continue
                zotero_data_dir = os.getenv("ZOTERO_DATA_DIR", os.path.expanduser("~/Zotero"))
                possible_path = os.path.join(zotero_data_dir, "storage", attachment_key, filename)
                
                if os.path.exists(possible_path):
                    return possible_path
    except Exception as e:
         print(f"Error retrieving PDF for {item_key}: {e}")
    return ""

def extract_text(pdf_path: str) -> str:
    """Extract text from a PDF file using PyMuPDF."""
    text_content = ""
    try:
        with fitz.open(pdf_path) as doc:
            for page in doc:
                text_content += page.get_text() + "\n"
        return text_content
    except Exception as e:
        print(f"Failed to extract text from {pdf_path}: {e}")
        return ""

def generate_embedding(text_content: str, model: SentenceTransformer) -> list:
    """Generate a vector embedding for the text using sentence-transformers."""
    # Truncate text context for embedding to fit typical context window of lightweight models
    truncated_text = text_content[:4000]
    embedding = model.encode(truncated_text)
    return embedding.tolist()

def update_zotero_item(item_key: str, text_content: str, tags: list) -> bool:
    """
    Tag the item and attach extracted text as a child note using the write API.
    """
    # 1. Add an 'embedded' tag (performed first so partial failure doesn't result in skipped items)
    if tags:
        tag_payload = {
            "operation": "set_item_tags",
            "item_key": item_key,
            "tags": tags
        }
        try:
            resp = requests.post(ZOTERO_WRITE_API_URL, json=tag_payload, timeout=5)
            resp.raise_for_status()
        except requests.exceptions.RequestException as e:
            print(f"API Error updating tags: {e}")
            return False

    # 2. Attach the note
    escaped_text = html.escape(text_content[:2000])
    note_html = f"<h1>Fulltext Content</h1><p><pre>{escaped_text}... (truncated)</pre></p>"
    
    attach_payload = {
        "operation": "attach_note",
        "parent_item_key": item_key,
        "note_text": note_html,
        "title": "Fulltext Content"
    }

    try:
        resp = requests.post(ZOTERO_WRITE_API_URL, json=attach_payload, timeout=5)
        resp.raise_for_status()
    except requests.exceptions.RequestException as e:
        print(f"API Error attaching note: {e}")
        return False

    return True

def main():
    print("Initializing offline processing pipeline...")
    client = get_local_zotero_client()
    
    print("Loading embedding model (this may take a moment)...")
    model = SentenceTransformer("all-MiniLM-L6-v2")
    
    print("Fetching items from Zotero...")
    # Fetch a small batch of items
    try:
        items = client.items(limit=30)
    except Exception as e:
        print(f"Error connecting to local Zotero API: {e}")
        print("Please ensure Zotero is running and the local API is enabled.")
        sys.exit(1)
    processed_count = 0
    
    for item in items:
        item_key = item.get("data", {}).get("key")
        title = item.get("data", {}).get("title", "Untitled")
        item_type = item.get("data", {}).get("itemType", "")
        
        # Only process standard items that might have PDFs
        if item_type in ["attachment", "note", "artwork", "computerProgram"]:
             continue
             
        print(f"\nProcessing {item_key}: {title[:50]}...")
        
        if has_fulltext_note(client, item_key):
             print("  -> Already has fulltext note. Skipping.")
             continue
             
        pdf_path = get_pdf_path(client, item_key)
        if not pdf_path:
             print("  -> No PDF attachment found.")
             continue
             
        print(f"  -> Found PDF at: {pdf_path}")
        
        print("  -> Extracting text with PyMuPDF...")
        text_content = extract_text(pdf_path)
        
        if not text_content.strip():
             print("  -> Text extraction failed or resulted in empty output.")
             continue
             
        print("  -> Generating semantic embedding via sentence-transformers...")
        embedding = generate_embedding(text_content, model)
        # Here you would typically save the embedding to a vector database (e.g. ChromaDB)
        # We will skip the DB insertion to keep the example lightweight, but we flag it as generated.
        
        print("  -> Updating Zotero item via Local Write API...")
        
        # Preserve existing tags and add our pipeline markers
        existing_tags = [t.get("tag") for t in item.get("data", {}).get("tags", []) if isinstance(t, dict) and "tag" in t]
        tags_to_set = []
        if embedding:
             tags_to_set = list(set(existing_tags + ["embedded", "fulltext-extracted"]))

        success = update_zotero_item(item_key, text_content, tags=tags_to_set)
        
        if success:
             print("  [OK] Extracted text attached and tags updated successfully!")
             processed_count += 1
        else:
             print("  [FAIL] Failed to update Zotero via local API.")
             
    print(f"\nPipeline complete. Processed {processed_count} new items.")

if __name__ == "__main__":
     main()
