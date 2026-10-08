/**
 * Live proof of `import_from_url`: one source URL in, one correct Zotero item
 * out, with the method that identified the source. Also proves that
 * `import_by_identifier` answers the citation keys of the items it creates.
 *
 * Every case drives a real running Zotero over real HTTP. The remote cases hit
 * the real publisher and metadata services, because the claim under test is
 * that the add-on composes Zotero's translators and recognizer with those
 * sources; the local cases serve fixture pages from this process so that each
 * method can be forced without depending on a third-party page layout.
 *
 * MUTATING: each case writes into the library. The file name has no `.test`
 * part, so `bun test` does not collect it; `just import-from-url-live` runs it by
 * path. `openImportSession` owns the setup and the cleanup.
 */
import { expect, test } from "bun:test";

import { citationHead } from "./fixture-server";
import { openImportSession } from "./import-session";
import {
  attachmentChildren,
  expectOneEntryWithOnePdf,
  expectStoredPdf,
  heldWork,
  readItem,
} from "./library";

const session = openImportSession();
const { uid, server } = session;

test("an arXiv abstract page becomes the preprint through the arXiv translator", async () => {
  const data = await session.importFromUrl("https://arxiv.org/abs/1706.03762");
  expect(data.method).toBe("web_translator");
  expect(data.existing).toBe(false);
  const item = await readItem(data.item_key);
  expect(item.itemType).toBe("preprint");
  expect(item.title).toBe("Attention Is All You Need");
  expect(item.DOI).toBe("10.48550/arXiv.1706.03762");
  expect(data.citation_key).toBe(item.citationKey);
  expect(data.citation_key).not.toBe("");
  await expectStoredPdf(data.item_key);
});

test("a DOI landing URL is followed to the publisher page and becomes the article; a second send returns the same item", async () => {
  const url = "https://doi.org/10.1371/journal.pmed.0020124";
  const first = await session.importFromUrl(url);
  expect(first.method).toBe("web_translator");
  expect(first.existing).toBe(false);
  const item = await readItem(first.item_key);
  expect(item.itemType).toBe("journalArticle");
  expect(item.title).toBe("Why Most Published Research Findings Are False");
  expect(item.DOI?.toLowerCase()).toBe("10.1371/journal.pmed.0020124");

  const second = await session.importFromUrl(url, { collection_keys: [session.collectionKey] });
  expect(second.existing).toBe(true);
  expect(second.item_key).toBe(first.item_key);
  expect((await readItem(first.item_key)).collections).toContain(session.collectionKey);
});

test("a direct PDF URL is recognized from the identifier inside the PDF", async () => {
  const data = await session.importFromUrl(
    "https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0000308&type=printable",
  );
  expect(data.method).toBe("pdf_recognition");
  expect(data.existing).toBe(false);
  const item = await readItem(data.item_key);
  expect(item.itemType).toBe("journalArticle");
  expect(item.DOI?.toLowerCase()).toBe("10.1371/journal.pone.0000308");
  await expectStoredPdf(data.item_key);
});

// A duplicate-merge add-on (Zoplicate, "keep" action) merges a library item into a newly
// saved duplicate, so a call that saves a second entry for a held work, even for a moment,
// can move or trash the library's own. Zoplicate waits up to 5 s for a new item's
// attachments before it merges.
test("a second import of a PDF the library holds answers its one entry with its one PDF", async () => {
  const url = "https://arxiv.org/pdf/1105.0003";
  const first = await session.importFromUrl(url);
  expect(first.existing).toBe(false);
  const held = await heldWork(first.item_key, "1105.0003");
  expectOneEntryWithOnePdf(held, first.item_key);
  const second = await session.importFromUrl(url);
  expect(second.method).toBe("pdf_recognition");
  expect(second.existing).toBe(true);
  expect(second.item_key).toBe(first.item_key);
  await Bun.sleep(10_000);
  expect(await heldWork(first.item_key, "1105.0003")).toEqual(held);
});

test("a direct PDF URL with store_attachments false becomes an item with no attachment", async () => {
  const data = await session.importFromUrl("https://arxiv.org/pdf/1105.0001", {
    store_attachments: false,
  });
  expect(data.method).toBe("pdf_recognition");
  expect(data.existing).toBe(false);
  expect(await attachmentChildren(data.item_key)).toEqual([]);
});

test("a translated page with store_attachments false becomes an item with no attachment", async () => {
  const data = await session.importFromUrl("https://arxiv.org/abs/1512.03385", {
    store_attachments: false,
  });
  expect(data.method).toBe("web_translator");
  expect(data.existing).toBe(false);
  expect((await readItem(data.item_key)).title).toBe(
    "Deep Residual Learning for Image Recognition",
  );
  expect(await attachmentChildren(data.item_key)).toEqual([]);
});

test("a page with only citation_* tags becomes a journal article in the requested collection", async () => {
  const title = `lw-citation-${uid}`;
  const url = server.servePage(`/citation-${uid}`, citationHead(title));
  const data = await session.importFromUrl(url, { collection_keys: [session.collectionKey] });
  expect(data.method).toBe("page_metadata");
  expect(data.existing).toBe(false);
  const item = await readItem(data.item_key);
  expect(item.itemType).toBe("journalArticle");
  expect(item.title).toBe(title);
  expect(item.creators.map((creator) => creator.lastName)).toEqual(["Fixture"]);
  expect(item.collections).toEqual([session.collectionKey]);

  const again = await session.importFromUrl(url);
  expect(again.existing).toBe(true);
  expect(again.item_key).toBe(data.item_key);
});

test("two different papers served at the same URL become two items", async () => {
  const path = `/shared-landing-${uid}`;
  const first = await session.importFromUrl(
    server.servePage(path, citationHead(`lw-shared-a-${uid}`)),
  );
  const second = await session.importFromUrl(
    server.servePage(path, citationHead(`lw-shared-b-${uid}`)),
  );
  expect(first.existing).toBe(false);
  expect(second.existing).toBe(false);
  expect(second.item_key).not.toBe(first.item_key);
  expect((await readItem(second.item_key)).title).toBe(`lw-shared-b-${uid}`);
});

test("a page with no metadata is identified by the arXiv ID in its URL", async () => {
  // A DOI in the URL is claimed first by Zotero's DOI web translator; no
  // web translator claims an arXiv ID outside arxiv.org.
  const url = server.servePage(`/papers/1512.03385`, "<title>Article</title>");
  const data = await session.importFromUrl(url);
  expect(data.method).toBe("identifier");
  const item = await readItem(data.item_key);
  expect(item.itemType).toBe("preprint");
  expect(item.DOI).toBe("10.48550/arXiv.1512.03385");
});

test("a page that publishes its BibTeX is imported from that BibTeX", async () => {
  // The uid goes into the record's key and title: import deduplicates on URL and title.
  const record = await Bun.file(new URL("../fixtures/uid-record.bib", import.meta.url)).text();
  server.serve(`/cite-${uid}.bib`, {
    body: record.replaceAll("__UID__", uid),
    type: "application/x-bibtex",
  });
  const url = server.servePage(
    `/bibtex-${uid}`,
    `<title>Landing</title><link rel="alternate" type="application/x-bibtex" href="/cite-${uid}.bib">`,
  );
  const data = await session.importFromUrl(url);
  expect(data.method).toBe("published_bibtex");
  const item = await readItem(data.item_key);
  expect(item.itemType).toBe("journalArticle");
  expect(item.title).toBe(`bibtex-fixture-${uid}`);
});

test("a page with only a title, an author and a year is identified by an external service", async () => {
  // Silverman's 2009 book has the same title; the author and year pick Tate's 1974 paper.
  const url = server.servePage(
    `/tate-${uid}`,
    [
      `<title>The arithmetic of elliptic curves</title>`,
      `<meta name="DC.title" content="The arithmetic of elliptic curves">`,
      `<meta name="DC.creator" content="Tate, John">`,
      `<meta name="DC.date" content="1974">`,
    ].join(""),
  );
  const data = await session.importFromUrl(url);
  expect(data.method).toBe("external_service");
  const item = await readItem(data.item_key);
  expect(item.itemType).toBe("journalArticle");
  expect(item.DOI?.toLowerCase()).toBe("10.1007/bf01389745");
});

test("import_by_identifier answers the citation key of every item it answers", async () => {
  const data = await session.importByIdentifier("arXiv:1512.03385");
  const keys = await Promise.all(
    data.item_keys.map(async (key) => (await readItem(key)).citationKey),
  );
  expect(data.citation_keys).toEqual(keys);
});

// The library holds each work as one entry with one PDF, so an identifier for a held work
// answers that entry. Zoplicate waits up to 5 s for a new item's attachments before it
// merges a duplicate.
test("import_by_identifier of an arXiv ID the library holds answers its one entry with its one PDF", async () => {
  const first = await session.importByIdentifier("arXiv:1105.0004");
  expect(first.item_keys).toEqual([first.item_key]);
  expect(first.existing).toEqual([false]);
  const held = await heldWork(first.item_key, "1105.0004");
  expectOneEntryWithOnePdf(held, first.item_key);
  const second = await session.importByIdentifier("arXiv:1105.0004");
  expect(second.item_keys).toEqual([first.item_key]);
  expect(second.existing).toEqual([true]);
  await Bun.sleep(10_000);
  expect(await heldWork(first.item_key, "1105.0004")).toEqual(held);
});
