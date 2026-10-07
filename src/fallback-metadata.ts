import { fileExistingItem, findExistingItem } from "./duplicates";
import { badRequest } from "./errors";
import { userLibraryID } from "./library";
import { storePdf } from "./pdf-recognition";
import { requireNonEmptyString, requireObject, requireString } from "./request-fields";
import { type FetchedSource, type ImportOutcome, UNRESOLVED_TAG } from "./source-results";

// ── fallback_metadata ───────────────────────────────────────────────
// What the caller asserts about a source that no method identifies. The item
// made from it carries UNRESOLVED_TAG, so it is citable now and reviewed later.

export type FallbackMetadata = {
  title: string;
  creators: FallbackCreator[];
  year: string;
};
// Zotero's creator JSON: an absent firstName is a creator known by surname only.
type FallbackCreator = { firstName?: string; lastName: string };

export function requireFallbackMetadata(value: unknown): FallbackMetadata {
  let fallback = requireObject(value, "fallback_metadata");
  let title = requireNonEmptyString(fallback.title, "fallback_metadata.title");
  let year = requireNonEmptyString(fallback.year, "fallback_metadata.year");
  if (!/^\d{4}$/.test(year)) {
    throw badRequest("fallback_metadata.year must be a four-digit year: " + year);
  }
  if (!Array.isArray(fallback.creators) || fallback.creators.length === 0) {
    throw badRequest("fallback_metadata.creators must name at least one creator");
  }
  let creators = fallback.creators.map((creator: unknown, index: number) => {
    let entry = requireObject(creator, "fallback_metadata.creators[" + index + "]");
    let parsed: FallbackCreator = {
      lastName: requireNonEmptyString(
        entry.last_name,
        "fallback_metadata.creators[" + index + "].last_name",
      ),
    };
    if (entry.first_name !== undefined) {
      parsed.firstName = requireString(
        entry.first_name,
        "fallback_metadata.creators[" + index + "].first_name",
      );
    }
    return parsed;
  });
  return { title, creators, year };
}

// The source as the caller describes it. A source already saved this way
// (equal URL and title) is returned as it is.
export async function saveFallback(
  url: string,
  source: FetchedSource | null,
  fallback: FallbackMetadata,
  collectionIDs: number[],
): Promise<ImportOutcome> {
  let itemType = "document" as const;
  let existing = await findExistingItem(
    { itemType, title: fallback.title, DOI: "", ISBN: "", url },
    null,
  );
  if (existing) {
    await fileExistingItem(existing, collectionIDs);
    return {
      item: existing,
      existing: true,
      method: "caller_metadata",
      translator: null,
      attachmentFailures: [],
    };
  }
  let item = new Zotero.Item(itemType);
  item.libraryID = userLibraryID();
  item.setField("title", fallback.title);
  item.setField("date", fallback.year);
  item.setField("url", url);
  item.setCreators(
    fallback.creators.map((creator) => ({ ...creator, creatorType: "author" as const })),
  );
  item.setTags([UNRESOLVED_TAG]);
  if (collectionIDs.length) {
    item.setCollections(collectionIDs);
  }
  await item.saveTx();
  if (source !== null && source.kind === "pdf") {
    await storePdf(source.finalUrl, item.id);
  }
  return {
    item,
    existing: false,
    method: "caller_metadata",
    translator: null,
    attachmentFailures: [],
  };
}
