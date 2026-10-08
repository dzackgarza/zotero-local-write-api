/**
 * Live proof of what `import_from_url` does with a source that no method
 * identifies: the typed 422 that names the alternatives, and the item saved
 * from the caller's `fallback_metadata`.
 *
 * Every case drives a real running Zotero over real HTTP against fixture pages
 * served from this process. MUTATING: the fallback cases write into the
 * library. The file name has no `.test` part, so `bun test` does not collect
 * it; `just import-from-url-live` runs it by path. `openImportSession` owns the
 * setup and the cleanup.
 */
import { expect, test } from "bun:test";

import { client, openImportSession } from "./import-session";
import { expectStoredPdf, libraryItemCount, readItem } from "./library";
import { liveSetting } from "./settings";

const session = openImportSession();
const { uid, server } = session;

// One title per case: a library's duplicate-merge add-on merges items that share a title.
function fallbackMetadata(name: string) {
  return {
    title: `lw-fallback-${name}-${uid}`,
    creators: [{ first_name: "Ada", last_name: "Fallbackauthor" }],
    year: "2019",
  };
}

type Remediation = {
  message: string;
  alternative_sources: { name: string; example: string }[];
  fallback_field: string;
};

test("a URL that no method identifies returns the typed error and creates nothing", async () => {
  const url = server.servePage(`/plain-${uid}`, "<title>Nothing here</title>");
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

test("an unidentified page with fallback_metadata becomes a citable item tagged for review", async () => {
  const url = server.servePage(`/plain-fallback-${uid}`, "<title>Nothing here</title>");
  const metadata = fallbackMetadata("page");
  const data = await session.importFromUrl(url, { fallback_metadata: metadata });
  expect(data.method).toBe("caller_metadata");
  expect(data.existing).toBe(false);
  const item = await readItem(data.item_key);
  expect(item.title).toBe(metadata.title);
  expect(item.creators).toEqual([
    { creatorType: "author", firstName: "Ada", lastName: "Fallbackauthor" },
  ]);
  expect(item.date).toBe("2019");
  expect(item.url).toBe(url);
  expect(item.tags.map((tag) => tag.tag)).toContain("metadata:unresolved");
  expect(data.citation_key).toBe(item.citationKey);
  expect(data.citation_key).not.toBe("");

  const again = await session.importFromUrl(url, { fallback_metadata: metadata });
  expect(again.existing).toBe(true);
  expect(again.item_key).toBe(data.item_key);
});

test("an unidentified PDF with fallback_metadata is stored under the new item", async () => {
  const url = server.servePdf(`/unidentified-${uid}.pdf`, `lw fixture body ${uid}`);
  const data = await session.importFromUrl(url, {
    fallback_metadata: fallbackMetadata("unidentified"),
  });
  expect(data.method).toBe("caller_metadata");
  await expectStoredPdf(data.item_key);
});

test("a PDF whose server streams it for longer than 30 s is imported", async () => {
  // 7 parts 5 s apart: the transfer takes 35 s, and the connection is never idle for 30 s.
  const url = server.servePdf(`/slow-${uid}.pdf`, `lw slow fixture body ${uid}`, {
    chunks: 7,
    secondsBetweenChunks: 5,
  });
  const data = await session.importFromUrl(url, { fallback_metadata: fallbackMetadata("slow") });
  expect(data.method).toBe("caller_metadata");
  await expectStoredPdf(data.item_key);
});

test("a PDF source is downloaded once, for recognition and storage together", async () => {
  const path = `/once-${uid}.pdf`;
  const url = server.servePdf(path, `lw once fixture body ${uid}`);
  const data = await session.importFromUrl(url, { fallback_metadata: fallbackMetadata("once") });
  expect(data.method).toBe("caller_metadata");
  await expectStoredPdf(data.item_key);
  expect(server.requestCount(path)).toBe(1);
});

test("fallback_metadata without a year is rejected and creates nothing", async () => {
  const before = await libraryItemCount();
  const url = server.servePage(`/plain-noyear-${uid}`, "<title>Nothing here</title>");
  const { title, creators } = fallbackMetadata("noyear");
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
