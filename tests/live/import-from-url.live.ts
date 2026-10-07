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
 * MUTATING: each case writes into the library. The file name has no `.test`
 * part, so `bun test` does not collect it; `just import-from-url-live` runs it by
 * path. Every item the operation reports as newly created is trashed in
 * `afterAll`, together with the scratch collection. Items reported as already
 * present are never touched, because they are the library's own.
 *
 * An unreachable Zotero fails the suite in `beforeAll`.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

import { createZoteroLocalWriteClient } from "../../src/client";
import { liveSetting } from "./settings";

const client = createZoteroLocalWriteClient(liveSetting("ZOTERO_LOCAL_BASE_URL"));

/** A URL under the library in Zotero's built-in read-only local API. */
function libraryUrl(path: string): string {
  const base = liveSetting("ZOTERO_LOCAL_BASE_URL");
  return `${base}/api/users/${liveSetting("ZOTERO_LIBRARY_ID")}/${path}`;
}

const uid = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const createdItemKeys: string[] = [];
let collectionKey = "";

type ItemData = {
  itemType: string;
  title: string;
  DOI?: string;
  date?: string;
  url?: string;
  citationKey: string;
  creators: { creatorType?: string; firstName?: string; lastName?: string }[];
  collections: string[];
  tags: { tag: string }[];
};

type ChildData = { itemType: string; contentType?: string; linkMode?: string };

/** Read an item back through Zotero's built-in read-only local API. */
async function readItem(itemKey: string): Promise<ItemData> {
  const url = libraryUrl(`items/${encodeURIComponent(itemKey)}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`read-back of ${itemKey} failed: HTTP ${response.status}`);
  }
  // Parsed from text: zotero-types shadows the global JSON type for response.json().
  return JSON.parse(await response.text()).data;
}

/** The files Zotero stores under an item, from the read-only local API. */
async function storedChildren(itemKey: string): Promise<ChildData[]> {
  const url = libraryUrl(`items/${encodeURIComponent(itemKey)}/children`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`children of ${itemKey} failed: HTTP ${response.status}`);
  }
  const children: { data: ChildData }[] = JSON.parse(await response.text());
  return children
    .map((child) => child.data)
    .filter((child) => child.itemType === "attachment" && child.linkMode === "imported_url");
}

async function expectStoredPdf(itemKey: string): Promise<void> {
  const contentTypes = (await storedChildren(itemKey)).map((child) => child.contentType);
  expect(contentTypes).toContain("application/pdf");
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

/**
 * A one-page PDF whose only text is `text`: no DOI, ISBN or arXiv ID, so
 * neither Zotero's recognizer nor identifier discovery can name the work.
 * Layout per ISO 32000-1 section 7.5 (header, objects, xref table, trailer).
 */
function servePdf(path: string, text: string): string {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fixtures.set(path, { body, type: "application/pdf" });
  return origin + path;
}

const FALLBACK_METADATA = {
  title: `lw-fallback-${uid}`,
  creators: [{ first_name: "Ada", last_name: "Fallbackauthor" }],
  year: "2019",
};

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
  const { data, error } = await client.POST("/write", {
    body: { operation: "create_collection", name: `lw-import-url-${uid}` },
  });
  if (error !== undefined || data === undefined || data.operation !== "create_collection") {
    throw new Error("scratch collection could not be created");
  }
  collectionKey = data.details.collection_key;
});

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
});

test("an arXiv abstract page becomes the preprint through the arXiv translator", async () => {
  const data = await importFromUrl("https://arxiv.org/abs/1706.03762");
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
});

test("a direct PDF URL is recognized from the identifier inside the PDF", async () => {
  const data = await importFromUrl(
    "https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0000308&type=printable",
  );
  expect(data.method).toBe("pdf_recognition");
  expect(data.existing).toBe(false);
  const item = await readItem(data.item_key);
  expect(item.itemType).toBe("journalArticle");
  expect(item.DOI?.toLowerCase()).toBe("10.1371/journal.pone.0000308");
  await expectStoredPdf(data.item_key);
});

test("a page with only citation_* tags becomes a journal article in the requested collection", async () => {
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
});

test("two different papers served at the same URL become two items", async () => {
  const path = `/shared-landing-${uid}`;
  const first = await importFromUrl(servePage(path, citationHead(`lw-shared-a-${uid}`)));
  const second = await importFromUrl(servePage(path, citationHead(`lw-shared-b-${uid}`)));
  expect(first.existing).toBe(false);
  expect(second.existing).toBe(false);
  expect(second.item_key).not.toBe(first.item_key);
  expect((await readItem(second.item_key)).title).toBe(`lw-shared-b-${uid}`);
});

test("a page with no metadata is identified by the arXiv ID in its URL", async () => {
  // A DOI in the URL is claimed first by Zotero's DOI web translator; no
  // web translator claims an arXiv ID outside arxiv.org.
  const url = servePage(`/papers/1512.03385`, "<title>Article</title>");
  const data = await importFromUrl(url);
  expect(data.method).toBe("identifier");
  const item = await readItem(data.item_key);
  expect(item.itemType).toBe("preprint");
  expect(item.DOI).toBe("10.48550/arXiv.1512.03385");
});

test("a page that publishes its BibTeX is imported from that BibTeX", async () => {
  // The uid goes into the record's key and title: import deduplicates on URL and title.
  const record = await Bun.file(new URL("../fixtures/uid-record.bib", import.meta.url)).text();
  fixtures.set(`/cite-${uid}.bib`, {
    body: record.replaceAll("__UID__", uid),
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
  expect(item.title).toBe(`bibtex-fixture-${uid}`);
});

test("a page with only a title, an author and a year is identified by an external service", async () => {
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
});

test("a URL that no method identifies returns the typed error and creates nothing", async () => {
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
  const remediation = (error.details as { remediation: Remediation }).remediation;
  expect(remediation.fallback_field).toBe("fallback_metadata");
  expect(remediation.alternative_sources.map((source) => source.name)).toContain("arXiv");
});

type Remediation = {
  message: string;
  alternative_sources: { name: string; example: string }[];
  fallback_field: string;
};

async function importWithFallback(url: string) {
  const { data, error } = await client.POST("/write", {
    body: { operation: "import_from_url", url, fallback_metadata: FALLBACK_METADATA },
  });
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

test("an unidentified page with fallback_metadata becomes a citable item tagged for review", async () => {
  const url = servePage(`/plain-fallback-${uid}`, "<title>Nothing here</title>");
  const data = await importWithFallback(url);
  expect(data.method).toBe("caller_metadata");
  expect(data.existing).toBe(false);
  const item = await readItem(data.item_key);
  expect(item.title).toBe(FALLBACK_METADATA.title);
  expect(item.creators).toEqual([
    { creatorType: "author", firstName: "Ada", lastName: "Fallbackauthor" },
  ]);
  expect(item.date).toBe("2019");
  expect(item.url).toBe(url);
  expect(item.tags.map((tag) => tag.tag)).toContain("metadata:unresolved");
  expect(data.citation_key).toBe(item.citationKey);
  expect(data.citation_key).not.toBe("");

  const again = await importWithFallback(url);
  expect(again.existing).toBe(true);
  expect(again.item_key).toBe(data.item_key);
});

test("an unidentified PDF with fallback_metadata is stored under the new item", async () => {
  const url = servePdf(`/unidentified-${uid}.pdf`, `lw fixture body ${uid}`);
  const data = await importWithFallback(url);
  expect(data.method).toBe("caller_metadata");
  await expectStoredPdf(data.item_key);
});

test("fallback_metadata without a year is rejected and creates nothing", async () => {
  const before = await libraryItemCount();
  const url = servePage(`/plain-noyear-${uid}`, "<title>Nothing here</title>");
  const { title, creators } = FALLBACK_METADATA;
  // Sent as raw JSON: the typed client would refuse the missing year at compile time.
  const response = await fetch(`${liveSetting("ZOTERO_LOCAL_BASE_URL")}/write`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      operation: "import_from_url",
      url,
      fallback_metadata: { title, creators },
    }),
  });
  expect(response.status).toBe(400);
  expect(await libraryItemCount()).toBe(before);
});

test("import_by_identifier answers the citation key of every item it creates", async () => {
  const { data, error } = await client.POST("/write", {
    body: { operation: "import_by_identifier", identifier: "arXiv:1512.03385" },
  });
  if (error !== undefined || data === undefined || data.operation !== "import_by_identifier") {
    throw new Error("import_by_identifier failed");
  }
  createdItemKeys.push(...data.item_keys);
  const keys = await Promise.all(
    data.item_keys.map(async (key) => (await readItem(key)).citationKey),
  );
  expect(data.citation_keys).toEqual(keys);
});

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
  const url = libraryUrl("items/top?limit=1");
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`item count failed: HTTP ${response.status}`);
  }
  return Number(response.headers.get("Total-Results"));
}

test("resolve_url returns the metadata import_from_url would save, and saves nothing", async () => {
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
});
