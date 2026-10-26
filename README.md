# Local Write API

Zotero add-on that registers local HTTP write endpoints on Zotero's existing server at `http://127.0.0.1:23119`. Zotero's built-in local API is read-only; this add-on adds item, note, attachment, collection, and tag mutations for the user library.

## Install

Install the release `.xpi` in Zotero from `Tools -> Add-ons -> Install Add-on From File`.

Zotero must be running while clients call these endpoints.
Zotero's local HTTP server must be enabled at `http://127.0.0.1:23119`. The endpoints require no API key because they run on Zotero's local HTTP server.

## Endpoints

Full request/response schemas for all three endpoints (`GET /version`, `POST /attach`, `POST /write` and its ~32 `operation` variants) live in [`openapi.yaml`](./openapi.yaml), an OpenAPI 3.1 document.
Paste it into [Swagger Editor](https://editor.swagger.io/) or any OpenAPI viewer to browse it.

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
