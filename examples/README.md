# Local API Examples

This directory contains standalone examples demonstrating how combining Zotero's read-only local API (via `pyzotero`) with the `zotero-local-write-api` add-on enables powerful automated workflows entirely on your local machine.

## Prerequisites

Most examples use external libraries. Install them via:
```bash
pip install -r requirements.txt
```

Ensure your Zotero is running with the `zotero-local-write-api` extension installed.

## Scripts

### 1. `live_smoke.py`
Real runtime smoke proof for the add-on itself. It uses Zotero's built-in local API plus the add-on endpoints to:
- verify `/version`
- create a real item
- attach a PDF via byte upload
- delete one tag while preserving another
- trash the temporary item

This is the required pre-release proof for `/attach` and `/write` behavior. Run it against a real Zotero with the current working-tree XPI installed before tagging any release.

**Usage:**
```bash
python live_smoke.py
python live_smoke.py --expected-version 3.2.3
```

### 2. `find_item_by_bibtex.py`
A simple demonstration of searching a local Zotero library for a specific Better BibTeX citation key using the standard `pyzotero` interface. It falls back to searching the entire library if not found in recent items.

**Usage:**
```bash
python find_item_by_bibtex.py [citation_key]
python find_item_by_bibtex.py Ale22
```

### 3. `offline_pipeline.py`
A complete offline document processing pipeline that:
1. Discovers parent items in your library missing extracted fulltext notes.
2. Identifies and reads local PDF paths directly using the native Zotero data storage (avoiding HTTP overhead for blobs).
3. Uses **`PyMuPDF`** to extract text content rapidly.
4. Generates dense vector embeddings representing the document using **`sentence-transformers`** (e.g. `all-MiniLM-L6-v2`).
5. Transmits the rich extracted text and the generated tracking tags ("embedded") back to Zotero using the `/write` API endpoints provided by this add-on.

**Usage:**
```bash
python offline_pipeline.py
```
*(Note: Downloading the sentence-transformers model takes a moment on the first run.)*
