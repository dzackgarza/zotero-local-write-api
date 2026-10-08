import { type DuplicateKeys, fileExistingItem } from "./duplicates";
import { badRequest } from "./errors";
import { userLibraryID } from "./library";
import { findExistingOutsideRecognition, storePdf } from "./pdf-recognition";
import { requireNonEmptyString, requireObject, requireString } from "./request-fields";
import {
  type FetchedSource,
  type ImportOutcome,
  type SaveTarget,
  UNRESOLVED_TAG,
} from "./source-results";

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

function requireFallbackCreator(creator: unknown, index: number): FallbackCreator {
  let path = "fallback_metadata.creators[" + index + "]";
  let entry = requireObject(creator, path);
  let parsed: FallbackCreator = {
    lastName: requireNonEmptyString(entry.last_name, path + ".last_name"),
  };
  if (entry.first_name !== undefined) {
    parsed.firstName = requireString(entry.first_name, path + ".first_name");
  }
  return parsed;
}

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
  let creators = fallback.creators.map(requireFallbackCreator);
  return { title, creators, year };
}

// A new document item with the caller's metadata and UNRESOLVED_TAG.
async function saveFallbackItem(
  url: string,
  fallback: FallbackMetadata,
  collectionIDs: number[],
): Promise<Zotero.Item> {
  let item = new Zotero.Item("document");
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
  return item;
}

// The outcome for an item saved from the caller's metadata; it has no attachment failures.
function fallbackOutcome(item: Zotero.Item, existing: boolean): ImportOutcome {
  return { item, existing, method: "caller_metadata", translator: null, attachmentFailures: [] };
}

// The duplicate keys of the item saveFallbackItem makes: it has no DOI and no ISBN.
function fallbackDuplicateKeys(url: string, fallback: FallbackMetadata): DuplicateKeys {
  return { itemType: "document", title: fallback.title, DOI: "", ISBN: "", url };
}

// The source as the caller describes it. A source already saved this way
// (equal URL and title) is returned as it is. A PDF source is stored under a new item
// when the target stores attachments.
export async function saveFallback(
  url: string,
  source: FetchedSource | null,
  fallback: FallbackMetadata,
  target: SaveTarget,
): Promise<ImportOutcome> {
  let existing = await findExistingOutsideRecognition(fallbackDuplicateKeys(url, fallback));
  if (existing) {
    await fileExistingItem(existing, target.collectionIDs);
    return fallbackOutcome(existing, true);
  }
  let item = await saveFallbackItem(url, fallback, target.collectionIDs);
  if (target.storeAttachments && source !== null && source.kind === "pdf") {
    await storePdf(source, item.id);
  }
  return fallbackOutcome(item, false);
}
