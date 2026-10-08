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
import { expectOneEntryWithOnePdf, heldWork, libraryItemCount, readItem } from "./library";

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

// Both operations recognize the PDF at once; the import files the one entry.
test("resolve_url and import_from_url of one PDF at once: the import's item exists", async () => {
  const url = "https://arxiv.org/pdf/1105.0001";
  const before = await libraryItemCount();
  const [resolved, imported] = await Promise.all([resolveUrl(url), session.importFromUrl(url)]);
  expect(resolved.method).toBe("pdf_recognition");
  expect(imported.method).toBe("pdf_recognition");
  expect((await readItem(imported.item_key)).title).toBe(String(resolved.csl.title));
  expect(imported.existing).toBe(false);
  expect(await libraryItemCount()).toBe(before + 1);
  expectOneEntryWithOnePdf(await heldWork(imported.item_key), imported.item_key);
});

// A duplicate-merge add-on (Zoplicate, "keep" action) merges a library item into a newly
// saved duplicate, so a call that saves a second entry for a held work, even for a moment,
// can move or trash the library's own. Zoplicate waits up to 5 s for a new item's
// attachments before it merges.
test("resolve_url of a PDF the library holds leaves its one entry with its one PDF", async () => {
  const url = "https://arxiv.org/pdf/1105.0002";
  const imported = await session.importFromUrl(url);
  expect(imported.existing).toBe(false);
  const held = await heldWork(imported.item_key);
  expectOneEntryWithOnePdf(held, imported.item_key);
  const resolved = await resolveUrl(url);
  expect(resolved.method).toBe("pdf_recognition");
  await Bun.sleep(10_000);
  expect(await heldWork(imported.item_key)).toEqual(held);
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

test("resolve_url downloads a PDF source once", async () => {
  const path = `/resolve-once-${uid}.pdf`;
  const url = server.servePdf(path, `lw resolve once fixture body ${uid}`);
  const { response } = await client.POST("/write", {
    body: { operation: "resolve_url", url },
  });
  expect(response.status).toBe(422);
  expect(server.requestCount(path)).toBe(1);
});
