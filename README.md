# Local Write API

Zotero add-on that registers local HTTP write endpoints on Zotero's existing server at `http://127.0.0.1:23119`.
Zotero's built-in local API is read-only; this add-on adds item, note, attachment, collection, and tag mutations for the user library.

## Install

Install the release `.xpi` in Zotero from `Tools -> Add-ons -> Install Add-on From File`.

Zotero must be running while clients call these endpoints.
Zotero's local HTTP server must be enabled at `http://127.0.0.1:23119`.
The endpoints require no API key because they run on Zotero's local HTTP server.

## Endpoints

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| `GET` | `/version` | none | Health check plus version, endpoint paths, Zotero compatibility, and capabilities. |
| `POST` | `/attach` | JSON object matching the attachment schema below. | `success`, `operation`, `stage`, `version`, `details`, `attachment_key`, `attachment_id`, `message`, `handler`. |
| `POST` | `/write` | JSON object with `operation` plus the operation schema below. | `success`, `operation`, `stage`, `version`, and operation-specific result fields. |

Failed requests return HTTP 500 with:

```json
{
  "success": false,
  "operation": "operation_name",
  "stage": "write_endpoint",
  "error": "message",
  "details": { "request": {} },
  "version": "3.2.0-dev"
}
```

## `/version`

```bash
curl http://127.0.0.1:23119/version
```

Returns:

```json
{
  "success": true,
  "healthy": true,
  "status": "ok",
  "message": "Local Write API is running.",
  "version": "3.2.0-dev",
  "addon_id": "local-write-api@dzackgarza.com",
  "homepage_url": "https://github.com/dzackgarza/zotero-local-write-api",
  "update_url": "https://raw.githubusercontent.com/dzackgarza/zotero-local-write-api/main/updates.json",
  "endpoints": {
    "attach": "/attach",
    "write": "/write",
    "version": "/version"
  },
  "compatibility": {
    "strict_min_version": "7.0",
    "strict_max_version": "*",
    "tested_zotero_version": "8.0.1"
  },
  "capabilities": [
    "attach",
    "attach_bytes",
    "write",
    "version_probe",
    "health_probe",
    "import_by_identifier",
    "selected_collection"
  ]
}
```

## `/attach`

Attaches a stored file to an existing Zotero parent item.

```http
POST /attach
Content-Type: application/json
```

Path-backed request:

```json
{
  "item_key": "ABCD1234",
  "title": "Extracted full text",
  "file_path": "/tmp/extracted.txt"
}
```

Byte-backed request:

```json
{
  "item_key": "ABCD1234",
  "title": "Uploaded PDF",
  "file_name": "paper.pdf",
  "file_bytes_base64": "JVBERi0xLjQK..."
}
```

Schema:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `item_key` | non-empty string | yes | Parent item key in the user library. |
| `title` | non-empty string | yes | Attachment title. |
| `file_path` | non-empty string | one of `file_path` or `file_bytes_base64` | Must be under `/tmp` or `/var/tmp`. |
| `file_name` | non-empty string | required when only `file_bytes_base64` is supplied | Used for the temporary uploaded file. |
| `file_bytes_base64` | non-empty string | one of `file_path` or `file_bytes_base64` | Base64 bytes. If `file_path` is present and missing at runtime, bytes are used as a fallback. |

Response:

```json
{
  "success": true,
  "operation": "attach_file_to_item",
  "stage": "completed",
  "version": "3.2.0-dev",
  "details": {
    "parent_item_key": "ABCD1234",
    "file_path": null,
    "source_mode": "bytes",
    "title": "Uploaded PDF"
  },
  "attachment_key": "WXYZ5678",
  "attachment_id": 123,
  "message": "File attached successfully to item ABCD1234",
  "handler": "fulltext-attach"
}
```

## `/write`

`/write` is the general Zotero operation endpoint.
It performs the library mutations and local UI queries that Zotero's built-in
local API does not expose for the user library:

- create, update, copy, merge, trash, and restore Zotero items
- import new Zotero items from DOI, ISBN, arXiv ID, PMID, or other identifiers
  Zotero can parse
- create, update, and attach child notes and URL attachments
- attach, relink, and retitle attachment files
- create, rename, move, merge, trash, and assign collections
- add, remove, replace, rename, merge, and purge tags
- return the collection currently selected in the active Zotero pane

Every request is a JSON object with an `operation` string and the fields required
by that operation.

```http
POST /write
Content-Type: application/json
```

```json
{
  "operation": "create_item",
  "item_type": "book",
  "fields": {
    "title": "Example Book"
  },
  "tags": ["to-read"],
  "collection_keys": ["COLL1234"]
}
```

Accepted operations:

| Operation | Required fields | Optional fields | Effect |
| --- | --- | --- | --- |
| `create_item` | `item_type: string` | `fields: object`, `tags: string[]`, `collection_keys: string[]` | Create a new Zotero item in the user library. |
| `import_by_identifier` | `identifier: string` | `collection_keys: string[]` | Ask Zotero translators to import items from DOI, ISBN, arXiv ID, PMID, or another identifier Zotero can parse. Attachments are saved when Zotero's translator provides them. |
| `update_item_fields` | `item_key: string`, `fields: object` | none | Merge fields into an existing item's Zotero JSON. |
| `replace_item_json` | `item_key: string`, `item_json: object` | none | Replace an existing item from Zotero item JSON. |
| `copy_item` | `item_key: string` | none | Clone an item. Regular items include child notes and attachments. |
| `merge_items` | `source_key: string`, `target_key: string` | none | Move tags, relations, notes, and attachments to target, then trash source. |
| `trash_item` | `item_key: string` | none | Move an item to the trash. |
| `restore_item` | `item_key: string` | none | Restore a trashed item. |
| `attach_note` | `parent_item_key: string`, `note_text: string` | `title: string` | Create a child note. `title` is reported back but Zotero note content comes from `note_text`. |
| `update_note` | `note_key: string`, `new_content: string` | none | Replace note HTML/text content. |
| `attach_url` | `parent_item_key: string`, `url: string` | `title: string` | Create a linked URL attachment. |
| `relink_attachment_file` | `attachment_key: string`, `file_path: string` | none | Relink an existing attachment to a local file. |
| `update_attachment_title` | `attachment_key: string`, `new_title: string` | none | Change an attachment title. |
| `set_item_tags` | `item_key: string`, `tags: string[]` | none | Replace all tags on an item. |
| `add_item_tags` | `item_key: string`, `tags: string[]` | none | Add tags that are not already present. |
| `remove_item_tags` | `item_key: string`, `tags: string[]` | none | Remove matching tags. |
| `rename_tag` | `old_name: string`, `new_name: string` | none | Rename a tag across the user library. |
| `merge_tags` | `source_tags: string[]`, `target_tag: string` | none | Rename source tags to the target tag. |
| `delete_tag` | `tag_name: string` | none | Remove a tag from the user library. |
| `delete_unused_tags` | none | none | Purge unused tags. |
| `create_collection` | `name: string` | `parent_key: string` | Create a collection, optionally under a parent collection. |
| `rename_collection` | `collection_key: string`, `new_name: string` | none | Rename a collection. |
| `move_collection` | `collection_key: string` | `new_parent_key: string` | Move a collection. Omit `new_parent_key` to make it top-level. |
| `merge_collections` | `source_keys: string[]`, `target_key: string` | none | Move source items and child collections into target, then trash sources. |
| `trash_collection` | `collection_key: string` | none | Move a collection to the trash. |
| `set_item_collections` | `item_key: string`, `collection_keys: string[]` | none | Replace collection membership. |
| `add_item_to_collection` | `item_key: string`, `collection_key: string` | none | Add an item to one collection. |
| `remove_item_from_collection` | `item_key: string`, `collection_key: string` | none | Remove an item from one collection. |
| `get_selected_collection` | none | none | Return the key and name of the collection selected in Zotero's active pane. |

String fields marked `string` must be non-empty unless the table says otherwise.
String arrays must contain strings; blank entries and duplicates are ignored.
Collection keys are validated before item collection writes.

The `import_by_identifier` implementation follows Zotero's own identifier
extraction and translator flow: it parses identifiers with
`Zotero.Utilities.extractIdentifiers`, runs `Zotero.Translate.Search`, saves
translated items into the user library, and saves translator-provided
attachments.

Response shape:

```json
{
  "success": true,
  "operation": "create_item",
  "stage": "completed",
  "version": "3.2.0-dev",
  "details": {
    "item_type": "book",
    "field_names": ["title"],
    "tag_count": 1,
    "collection_count": 0
  },
  "item_key": "ABCD1234",
  "item_id": 123
}
```

## Examples

Create an item:

```bash
curl -X POST http://127.0.0.1:23119/write \
  -H 'Content-Type: application/json' \
  -d '{"operation":"create_item","item_type":"book","fields":{"title":"Example Book"},"tags":["to-read"]}'
```

Attach uploaded bytes:

```bash
curl -X POST http://127.0.0.1:23119/attach \
  -H 'Content-Type: application/json' \
  -d '{"item_key":"ABCD1234","title":"paper.pdf","file_name":"paper.pdf","file_bytes_base64":"JVBERi0xLjQK"}'
```

See [`examples/`](./examples/) for Python clients and the live smoke proof.

## Configuration

The add-on ID, endpoint paths, compatibility range, update URL, and file-path attachment allowlist live in [`config.yml`](./config.yml).

## License

MIT; see [`LICENSE`](./LICENSE).
