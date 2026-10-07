/**
 * Live proof of `resolve_url`: it identifies a source exactly as
 * `import_from_url` does and returns the metadata without saving anything.
 *
 * Every case drives a real running Zotero over real HTTP. The file name has no
 * `.test` part, so `bun test` does not collect it; `just import-from-url-live`
 * runs it by path. `openImportSession` owns the setup and the cleanup.
 */
import { expect, test } from "bun:test";

import { citationHead } from "./fixture-server";
import { client, openImportSession } from "./import-session";
import { libraryItemCount } from "./library";

const session = openImportSession();
const { uid, server } = session;

async function resolveUrl(url: string) {
  const { data, error } = await client.POST("/write", {
    body: { operation: "resolve_url", url },
  });
  if (error !== undefined) {
    throw new Error(`resolve_url ${url} failed: ${error.stage}: ${error.error}`);
  }
  if (data === undefined || data.operation !== "resolve_url") {
    throw new Error(`resolve_url ${url} returned no resolve_url success`);
  }
  return data;
}

test("resolve_url returns the metadata import_from_url would save, and saves nothing", async () => {
  const title = `lw-resolve-${uid}`;
  const url = server.servePage(`/resolve-${uid}`, citationHead(title));
  const before = await libraryItemCount();
  const data = await resolveUrl(url);
  expect(data.method).toBe("page_metadata");
  expect(data.item_type).toBe("journalArticle");
  expect(data.csl.title).toBe(title);
  expect(data.csl.author).toEqual([{ family: "Fixture", given: "Ada" }]);
  expect(data.csl.issued).toEqual({ "date-parts": [["2021", 3, 4]] });
  expect(await libraryItemCount()).toBe(before);
});

test("resolve_url recognizes a direct PDF URL and leaves no item behind", async () => {
  const before = await libraryItemCount();
  const data = await resolveUrl(
    "https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0000308&type=printable",
  );
  expect(data.method).toBe("pdf_recognition");
  expect(data.item_type).toBe("journalArticle");
  expect(String(data.csl.DOI).toLowerCase()).toBe("10.1371/journal.pone.0000308");
  expect(await libraryItemCount()).toBe(before);
});

test("resolve_url on a URL that no method identifies returns the typed error", async () => {
  const url = server.servePage(`/plain-resolve-${uid}`, "<title>Nothing here</title>");
  const { data, error, response } = await client.POST("/write", {
    body: { operation: "resolve_url", url },
  });
  expect(data).toBeUndefined();
  expect(response.status).toBe(422);
  if (error === undefined) {
    throw new Error("expected the error branch");
  }
  expect(error.operation).toBe("resolve_url");
  expect(error.stage).toBe("identify_source");
});
