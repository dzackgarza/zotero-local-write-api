# Zotero Attachment Plugin

Local Zotero add-on that fills the write gap in Zotero's built-in HTTP API.

## Why This Exists

Zotero 7 ships a read-only local HTTP API at `localhost:23119/api/` that covers every read operation an agent needs: fetch items by key, search the library, list collections, read tags, retrieve full-text, and execute saved searches. It requires no authentication and has no rate limits.

That API has **no write capability whatsoever.** Every endpoint is GET-only. This add-on exists to cover that gap until write support is implemented upstream. It registers additional endpoints on the same Zotero server that handle:

- Mutating item fields, tags, and collection membership
- Creating and trashing items, notes, and collections
- Attaching files and URLs to items
- Collection and tag management (rename, merge, move, delete)
- Creating items from scratch

It also exposes a file-attachment workflow that stages a file from disk into Zotero's storage, which the native API does not provide.

See [issue #1](https://github.com/dzackgarza/zotero-attachment-plugin/issues/1) for write operations not yet implemented.

## What It Ships

The endpoint names, add-on ID, compatibility range, and update URL live in [`config.yml`](./config.yml). The add-on registers three endpoints on Zotero's local HTTP server:

| Endpoint | Method | Purpose |
|---|---|---|
| `/attach` | POST | Attach a file from disk to a Zotero item |
| `/write` | POST | All write operations (dispatched by `operation` field) |
| `/version` | GET | Version probe and capability list |

The version probe lets consumers require a minimum installed add-on version before issuing write requests.

## Compatibility

- Zotero: `7.0` and later
- Tested against: `8.0.1`

## Repo Layout

```text
src/               Plugin source (bootstrap.js, icons, generated manifest.json)
examples/          Example python scripts demonstrating how to interact with the API
build.py           Builds the XPI from src/ and writes updates.json
config.yml         All stable constants — addon ID, repo, Zotero compatibility, endpoints
VERSION            Current version number (plain text, bumped by justfile)
updates.json       Committed; fetched by Zotero at the update_url for auto-update
justfile           Release workflow
```

## Examples

The `examples/` directory contains standalone python scripts demonstrating how to interact with local Zotero plus this API:

1. **[`find_item_by_bibtex.py`](./examples/find_item_by_bibtex.py)**: Shows how to search for an item in a local library through the `pyzotero` interface via its Better BibTeX citation key.
2. **[`offline_pipeline.py`](./examples/offline_pipeline.py)**: Demonstrates an end-to-end local text extraction pipeline, reading a PDF with standard APIs, extracting text via `PyMuPDF`, and attaching the result back to the Zotero item seamlessly using the `/write` endpoint.

## Build and Release

```bash
python3 build.py        # build the current working tree XPI
just smoke-live         # prove /version, /attach, delete_tag, and trash_item live
just release          # bump patch version, build, commit, tag, push
just release-minor    # bump minor version
just release-major    # bump major version
```

`VERSION` and `config.yml` are the two sources of truth. `build.py` derives everything else — `updates.json`, the XPI, and the injected constants in `bootstrap.js`.

Do not tag a release until the current working-tree XPI has been installed into a real Zotero and `just smoke-live` has passed. Static checks alone are not enough for this add-on because `/attach` and `/write` run inside Zotero's XPCOM runtime.

GitHub Actions picks up the tag and publishes the GitHub Release with the `.xpi` asset. Zotero polls `update_url` in the installed manifest and offers the update automatically.

Install the `.xpi` from Zotero's `Tools → Add-ons → Install Add-on From File`, then verify:

- `GET http://127.0.0.1:23119/version`
- `POST http://127.0.0.1:23119/attach`
- `POST http://127.0.0.1:23119/write`

The live smoke recipe accepts `EXPECTED_VERSION`, `ZOTERO_LOCAL_BASE_URL`, and `ZOTERO_LIBRARY_ID` from the environment when you need to pin the installed version or use a forwarded Zotero server.
