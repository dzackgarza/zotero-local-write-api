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

It also exposes `/fulltext-attach`, a file-attachment workflow that stages a file from disk into Zotero's storage — not available in the native API in any form.

See [issue #1](https://github.com/dzackgarza/zotero-attachment-plugin/issues/1) for write operations not yet implemented.

## What It Ships

The add-on lives in [`fulltext-attach-plugin`](./fulltext-attach-plugin) and registers three endpoints on Zotero's local HTTP server:

| Endpoint | Method | Purpose |
|---|---|---|
| `/fulltext-attach` | POST | Attach a file from disk to a Zotero item |
| `/opencode-zotero-write` | POST | All write operations (dispatched by `operation` field) |
| `/opencode-zotero-plugin-version` | GET | Version probe and capability list |

The version probe lets consumers require a minimum installed add-on version before issuing write requests.

## Compatibility

- Zotero: `7.0` and later
- Tested against: `8.0.1`

## Repo Layout

```text
fulltext-attach-plugin/   Add-on source, build scripts, manifest, and update manifest
examples/                 Example clients and requests
scripts/                  Utility scripts
tests/                    Add-on-specific verification assets
```

## Build and Release

```bash
just release          # bump patch version, build, commit, tag, push
just release-minor    # bump minor version
just release-major    # bump major version
```

GitHub Actions picks up the tag and publishes the GitHub Release with the `.xpi` asset. Zotero polls the `update_url` in the installed manifest and offers the update automatically.

[`version.py`](./fulltext-attach-plugin/version.py) is the single source of truth for the version number. Everything else is derived from it.

Install the generated `.xpi` from Zotero's `Tools -> Add-ons` menu, then verify:

- `GET http://127.0.0.1:23119/opencode-zotero-plugin-version`
- `POST http://127.0.0.1:23119/fulltext-attach`
- `POST http://127.0.0.1:23119/opencode-zotero-write`
