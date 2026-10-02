/**
 * Live proof of `import_from_url`: one source URL in, one correct Zotero item
 * out, with the method that identified the source.
 *
 * Every case drives a real running Zotero over real HTTP. The remote cases hit
 * the real publisher and metadata services, because the claim under test is
 * that the add-on composes Zotero's translators and recognizer with those
 * sources; the local cases serve fixture pages from this process so that each
 * method can be forced without depending on a third-party page layout.
 *
 * MUTATING: each case writes into the library, so the suite is opt-in via
 * ZOTERO_LIVE=1 and is never collected by ordinary `bun test` QC. Every item
 * the operation reports as newly created is trashed in `afterAll`, together
 * with the scratch collection. Items reported as already present are never
 * touched, because they are the library's own.
 *
 * Opted in but unreachable is a hard failure, never a skip.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

import { createZoteroLocalWriteClient } from "../src/client";

const LIVE = process.env.ZOTERO_LIVE === "1";
const BASE_URL = process.env.ZOTERO_LOCAL_BASE_URL ?? "http://127.0.0.1:23119";
const LIBRARY_ID = process.env.ZOTERO_LIBRARY_ID ?? "0";
// Remote translators and metadata services answer in seconds, but the PDF
// case downloads and recognizes a full article.
const REMOTE_TIMEOUT_MS = 180_000;

const client = createZoteroLocalWriteClient(process.env.ZOTERO_LOCAL_BASE_URL);

const uid = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const createdItemKeys: string[] = [];
let collectionKey = "";

type ItemData = {
  itemType: string;
  title: string;
  DOI?: string;
  creators: { lastName?: string }[];
  collections: string[];
};

/** Read an item back through Zotero's built-in read-only local API. */
async function readItem(itemKey: string): Promise<ItemData> {
  const url = `${BASE_URL}/api/users/${LIBRARY_ID}/items/${encodeURIComponent(itemKey)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`read-back of ${itemKey} failed: HTTP ${response.status}`);
  }
  // Parsed from text: zotero-types shadows the global JSON type for response.json().
  return JSON.parse(await response.text()).data;
}

// The fixture server stands in for a publisher. Its routes are fixed per test
// through `fixtures`, so one URL can serve different pages over time.
const fixtures = new Map<string, { body: string; type: string }>();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const fixture = fixtures.get(new URL(request.url).pathname);
    if (fixture === undefined) {
      return new Response("not found", { status: 404 });
    }
    return new Response(fixture.body, { headers: { "Content-Type": fixture.type } });
  },
});
const origin = `http://127.0.0.1:${server.port}`;

function servePage(path: string, head: string, body = "<p>fixture</p>"): string {
  fixtures.set(path, {
    body: `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`,
    type: "text/html; charset=utf-8",
  });
  return origin + path;
}

function citationHead(title: string): string {
  return [
    `<title>${title}</title>`,
    `<meta name="citation_title" content="${title}">`,
    `<meta name="citation_author" content="Fixture, Ada">`,
    `<meta name="citation_publication_date" content="2021/03/04">`,
    `<meta name="citation_journal_title" content="Journal of Fixtures">`,
  ].join("");
}

async function importFromUrl(url: string, collectionKeys?: string[]) {
  const body =
    collectionKeys === undefined
      ? { operation: "import_from_url" as const, url }
      : { operation: "import_from_url" as const, url, collection_keys: collectionKeys };
  const { data, error } = await client.POST("/write", { body });
  if (error !== undefined) {
    throw new Error(`import_from_url ${url} failed: ${error.stage}: ${error.error}`);
  }
  if (data === undefined || data.operation !== "import_from_url") {
    throw new Error(`import_from_url ${url} returned no import_from_url success`);
  }
  if (!data.existing) {
    createdItemKeys.push(data.item_key);
  }
  return data;
}

beforeAll(async () => {
  if (!LIVE) {
    return;
  }
  const { data, error } = await client.POST("/write", {
    body: { operation: "create_collection", name: `lw-import-url-${uid}` },
  });
  if (error !== undefined || data === undefined || data.operation !== "create_collection") {
    throw new Error("scratch collection could not be created");
  }
  collectionKey = data.details.collection_key;
}, REMOTE_TIMEOUT_MS);

afterAll(async () => {
  server.stop(true);
  for (const itemKey of createdItemKeys) {
    const { error } = await client.POST("/write", {
      body: { operation: "trash_item", item_key: itemKey },
    });
    if (error !== undefined) {
      throw new Error(`cleanup of ${itemKey} failed: ${error.error}`);
    }
  }
  if (collectionKey !== "") {
    const { error } = await client.POST("/write", {
      body: { operation: "trash_collection", collection_key: collectionKey },
    });
    if (error !== undefined) {
      throw new Error(`cleanup of ${collectionKey} failed: ${error.error}`);
    }
  }
}, REMOTE_TIMEOUT_MS);

test.skipIf(!LIVE)(
  "an arXiv abstract page becomes the preprint through the arXiv translator",
  async () => {
    const data = await importFromUrl("https://arxiv.org/abs/1706.03762");
    expect(data.method).toBe("web_translator");
    expect(data.existing).toBe(false);
    const item = await readItem(data.item_key);
    expect(item.itemType).toBe("preprint");
    expect(item.title).toBe("Attention Is All You Need");
    expect(item.DOI).toBe("10.48550/arXiv.1706.03762");
  },
  REMOTE_TIMEOUT_MS,
);

test.skipIf(!LIVE)(
  "a DOI landing URL is followed to the publisher page and becomes the article; a second send returns the same item",
  async () => {
    const url = "https://doi.org/10.1371/journal.pmed.0020124";
    const first = await importFromUrl(url);
    expect(first.method).toBe("web_translator");
    expect(first.existing).toBe(false);
    const item = await readItem(first.item_key);
    expect(item.itemType).toBe("journalArticle");
    expect(item.title).toBe("Why Most Published Research Findings Are False");
    expect(item.DOI?.toLowerCase()).toBe("10.1371/journal.pmed.0020124");

    const second = await importFromUrl(url, [collectionKey]);
    expect(second.existing).toBe(true);
    expect(second.item_key).toBe(first.item_key);
    expect((await readItem(first.item_key)).collections).toContain(collectionKey);
  },
  REMOTE_TIMEOUT_MS,
);

test.skipIf(!LIVE)(
  "a direct PDF URL is recognized from the identifier inside the PDF",
  async () => {
    const data = await importFromUrl(
      "https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0000308&type=printable",
    );
    expect(data.method).toBe("pdf_recognition");
    expect(data.existing).toBe(false);
    const item = await readItem(data.item_key);
    expect(item.itemType).toBe("journalArticle");
    expect(item.DOI?.toLowerCase()).toBe("10.1371/journal.pone.0000308");
  },
  REMOTE_TIMEOUT_MS,
);

test.skipIf(!LIVE)(
  "a page with only citation_* tags becomes a journal article in the requested collection",
  async () => {
    const title = `lw-citation-${uid}`;
    const url = servePage(`/citation-${uid}`, citationHead(title));
    const data = await importFromUrl(url, [collectionKey]);
    expect(data.method).toBe("page_metadata");
    expect(data.existing).toBe(false);
    const item = await readItem(data.item_key);
    expect(item.itemType).toBe("journalArticle");
    expect(item.title).toBe(title);
    expect(item.creators.map((creator) => creator.lastName)).toEqual(["Fixture"]);
    expect(item.collections).toEqual([collectionKey]);

    const again = await importFromUrl(url);
    expect(again.existing).toBe(true);
    expect(again.item_key).toBe(data.item_key);
  },
  REMOTE_TIMEOUT_MS,
);

test.skipIf(!LIVE)(
  "two different papers served at the same URL become two items",
  async () => {
    const path = `/shared-landing-${uid}`;
    const first = await importFromUrl(servePage(path, citationHead(`lw-shared-a-${uid}`)));
    const second = await importFromUrl(servePage(path, citationHead(`lw-shared-b-${uid}`)));
    expect(first.existing).toBe(false);
    expect(second.existing).toBe(false);
    expect(second.item_key).not.toBe(first.item_key);
    expect((await readItem(second.item_key)).title).toBe(`lw-shared-b-${uid}`);
  },
  REMOTE_TIMEOUT_MS,
);

test.skipIf(!LIVE)(
  "a page with no metadata is identified by the arXiv ID in its URL",
  async () => {
    // A DOI in the URL is claimed first by Zotero's DOI web translator; no
    // web translator claims an arXiv ID outside arxiv.org.
    const url = servePage(`/papers/1512.03385`, "<title>Article</title>");
    const data = await importFromUrl(url);
    expect(data.method).toBe("identifier");
    const item = await readItem(data.item_key);
    expect(item.itemType).toBe("preprint");
    expect(item.DOI).toBe("10.48550/arXiv.1512.03385");
  },
  REMOTE_TIMEOUT_MS,
);

test.skipIf(!LIVE)(
  "a page that publishes its BibTeX is imported from that BibTeX",
  async () => {
    const title = `lw-bibtex-${uid}`;
    fixtures.set(`/cite-${uid}.bib`, {
      body: `@article{fixture${uid},\n  title = {${title}},\n  author = {Fixture, Ada},\n  journal = {Journal of Fixtures},\n  year = {2020}\n}\n`,
      type: "application/x-bibtex",
    });
    const url = servePage(
      `/bibtex-${uid}`,
      `<title>Landing</title><link rel="alternate" type="application/x-bibtex" href="/cite-${uid}.bib">`,
    );
    const data = await importFromUrl(url);
    expect(data.method).toBe("published_bibtex");
    const item = await readItem(data.item_key);
    expect(item.itemType).toBe("journalArticle");
    expect(item.title).toBe(title);
  },
  REMOTE_TIMEOUT_MS,
);

test.skipIf(!LIVE)(
  "a page with only a title, an author and a year is identified by an external service",
  async () => {
    // Silverman's 2009 book has the same title; the author and year pick Tate's 1974 paper.
    const url = servePage(
      `/tate-${uid}`,
      [
        `<title>The arithmetic of elliptic curves</title>`,
        `<meta name="DC.title" content="The arithmetic of elliptic curves">`,
        `<meta name="DC.creator" content="Tate, John">`,
        `<meta name="DC.date" content="1974">`,
      ].join(""),
    );
    const data = await importFromUrl(url);
    expect(data.method).toBe("external_service");
    const item = await readItem(data.item_key);
    expect(item.itemType).toBe("journalArticle");
    expect(item.DOI?.toLowerCase()).toBe("10.1007/bf01389745");
  },
  REMOTE_TIMEOUT_MS,
);

test.skipIf(!LIVE)(
  "a URL that no method identifies returns the typed error and creates nothing",
  async () => {
    const url = servePage(`/plain-${uid}`, "<title>Nothing here</title>");
    const { data, error, response } = await client.POST("/write", {
      body: { operation: "import_from_url", url },
    });
    expect(data).toBeUndefined();
    expect(response.status).toBe(422);
    if (error === undefined) {
      throw new Error("expected the error branch");
    }
    expect(error.operation).toBe("import_from_url");
    expect(error.stage).toBe("identify_source");
  },
  REMOTE_TIMEOUT_MS,
);

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

/** The number of top-level items the library holds, from the read-only local API. */
async function libraryItemCount(): Promise<number> {
  const url = `${BASE_URL}/api/users/${LIBRARY_ID}/items/top?limit=1`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`item count failed: HTTP ${response.status}`);
  }
  return Number(response.headers.get("Total-Results"));
}

test.skipIf(!LIVE)(
  "resolve_url returns the metadata import_from_url would save, and saves nothing",
  async () => {
    const title = `lw-resolve-${uid}`;
    const url = servePage(`/resolve-${uid}`, citationHead(title));
    const before = await libraryItemCount();
    const data = await resolveUrl(url);
    expect(data.method).toBe("page_metadata");
    expect(data.item_type).toBe("journalArticle");
    expect(data.csl.title).toBe(title);
    expect(data.csl.author).toEqual([{ family: "Fixture", given: "Ada" }]);
    expect(data.csl.issued).toEqual({ "date-parts": [["2021", 3, 4]] });
    expect(await libraryItemCount()).toBe(before);
  },
  REMOTE_TIMEOUT_MS,
);

test.skipIf(!LIVE)(
  "resolve_url recognizes a direct PDF URL and leaves no item behind",
  async () => {
    const before = await libraryItemCount();
    const data = await resolveUrl(
      "https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0000308&type=printable",
    );
    expect(data.method).toBe("pdf_recognition");
    expect(data.item_type).toBe("journalArticle");
    expect(String(data.csl.DOI).toLowerCase()).toBe("10.1371/journal.pone.0000308");
    expect(await libraryItemCount()).toBe(before);
  },
  REMOTE_TIMEOUT_MS,
);

test.skipIf(!LIVE)(
  "resolve_url on a URL that no method identifies returns the typed error",
  async () => {
    const url = servePage(`/plain-resolve-${uid}`, "<title>Nothing here</title>");
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
  },
  REMOTE_TIMEOUT_MS,
);
