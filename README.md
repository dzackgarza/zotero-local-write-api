# Local Write API

Zotero add-on that registers local HTTP write endpoints on Zotero's existing server at `http://127.0.0.1:23119`. Zotero's built-in local API is read-only; this add-on adds item, note, attachment, collection, and tag mutations for the user library.

## Install

Install the release `.xpi` in Zotero from `Tools -> Add-ons -> Install Add-on From File`.

Zotero must be running while clients call these endpoints.
Zotero's local HTTP server must be enabled at `http://127.0.0.1:23119`. The endpoints require no API key because they run on Zotero's local HTTP server.

## Endpoints

Full request/response schemas for all endpoints (`GET /version`, `GET /openapi.yaml`, `POST /attach`, `POST /write` and its ~32 `operation` variants) live in [`openapi.yaml`](./openapi.yaml), an OpenAPI 3.1 document.
Paste it into [Swagger Editor](https://editor.swagger.io/) or any OpenAPI viewer to browse it.
The running plugin also serves it at `GET /openapi.yaml`.

`POST /write` and `POST /attach` optionally require `Authorization: Bearer <token>` — set the `extensions.zotero.localWriteAPI.token` preference to enable this.
That is mandatory before exposing the API beyond loopback: [docs/gpt-action.md](./docs/gpt-action.md) walks through publishing it at a Cloudflare tunnel and importing it into a Custom GPT as an Action, with a systemd user service (`just tunnel-setup`, `just tunnel-install`) keeping the tunnel up.

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

## TypeScript client

`openapi.yaml` is the source for a typed client.
The types in `src/generated/openapi.ts` are generated from it and committed, and `src/client.ts` wraps [`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/) with the local server's base URL:

```ts
import { createZoteroLocalWriteClient } from "./src/client";

const client = createZoteroLocalWriteClient(); // defaults to http://127.0.0.1:23119
const { data, error } = await client.POST("/write", {
  body: { operation: "create_item", item_type: "book", fields: { title: "Example Book" } },
});

if (error) throw new Error(error.error); // typed ErrorResponse
if (data.operation === "create_item") console.log(data.item_key); // narrowed by `operation`
```

Responses are a discriminated union: narrow on `data.operation` to reach an operation's own fields.
Note that Zotero NFC-normalizes the text it stores, so a title or tag read back is `NFC(sent)` rather than the exact bytes sent.

Regenerate the types after any change to `openapi.yaml` (`openapi:check` fails on drift, so this is not optional):

```bash
bun run openapi:generate   # rewrite src/generated/openapi.ts from openapi.yaml
bun run openapi:check      # lint + generated-drift + dispatch conformance
```

## Configuration

The add-on ID, endpoint paths, compatibility range, update URL, and file-path attachment allowlist live in [`config.yml`](./config.yml).

## License

MIT; see [`LICENSE`](./LICENSE).
