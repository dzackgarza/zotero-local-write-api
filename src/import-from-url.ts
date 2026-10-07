import { duplicateKeysFromJSON, fileExistingItem, findExistingItem } from "./duplicates";
import { type FallbackMetadata, requireFallbackMetadata, saveFallback } from "./fallback-metadata";
import { identifyPage } from "./identify-page";
import { citationKey, userCollectionIDs, userLibraryID } from "./library";
import { hasStoredPdf, recognizePdf, storePdf } from "./pdf-recognition";
import { normalizeStringList } from "./request-fields";
import { type RequestData, successResult } from "./responses";
import { fetchSource, requireHttpUrl } from "./source-fetch";
import { identifierText, identifyByIdentifier } from "./source-methods";
import {
  type AttachmentFailure,
  type Attempt,
  type FetchedSource,
  type Identification,
  type ImportOutcome,
  recordAttempt,
  type SourceMethod,
  SourceNotIdentifiedError,
  translatorDetails,
} from "./source-results";
import { type ZoteroTranslateApi } from "./zotero-api";

async function saveIdentification(
  identification: Identification & { method: SourceMethod },
  collectionIDs: number[],
): Promise<ImportOutcome> {
  let existing = await findExistingItem(duplicateKeysFromJSON(identification.json), null);
  if (existing) {
    await fileExistingItem(existing, collectionIDs);
    return {
      item: existing,
      existing: true,
      method: identification.method,
      translator: identification.translator,
      attachmentFailures: [],
    };
  }
  let attachmentFailures: AttachmentFailure[] = [];
  let translateApi = Zotero.Translate as ZoteroTranslateApi;
  let saver = new translateApi.ItemSaver({
    libraryID: userLibraryID(),
    collections: collectionIDs.length ? collectionIDs : false,
    // The Zotero Connector's mode: the translator's attachments are stored, and
    // an open-access PDF is looked up when the translator gives none.
    attachmentMode: translateApi.ItemSaver.ATTACHMENT_MODE_DOWNLOAD,
  });
  let items = await saver.saveItems([identification.json], (attachment, progress, error) => {
    if (progress === false) {
      attachmentFailures.push({
        title: attachment.title === undefined ? null : attachment.title,
        url: attachment.url === undefined ? null : attachment.url,
        error: String(error),
      });
    }
  });
  if (items.length !== 1) {
    throw new Error("import_from_url saved " + items.length + " items instead of one");
  }
  return {
    item: items[0],
    existing: false,
    method: identification.method,
    translator: identification.translator,
    attachmentFailures,
  };
}

async function importPdfSource(
  requestedUrl: string,
  finalUrl: string,
  collectionIDs: number[],
  attempts: Attempt[],
): Promise<ImportOutcome | null> {
  let recognized = recordAttempt(
    attempts,
    "pdf_recognition",
    await recognizePdf(finalUrl, collectionIDs),
  );
  if (recognized) {
    return { ...recognized, method: "pdf_recognition" };
  }
  let byIdentifier = recordAttempt(
    attempts,
    "identifier",
    await identifyByIdentifier(identifierText([requestedUrl, finalUrl], null)),
  );
  if (byIdentifier === null) {
    return null;
  }
  let outcome = await saveIdentification({ ...byIdentifier, method: "identifier" }, collectionIDs);
  if (!outcome.existing && !hasStoredPdf(outcome.item)) {
    await storePdf(finalUrl, outcome.item.id);
  }
  return outcome;
}

async function identifySource(
  url: string,
  source: FetchedSource,
  collectionIDs: number[],
  attempts: Attempt[],
): Promise<ImportOutcome | null> {
  if (source.kind === "pdf") {
    return importPdfSource(url, source.finalUrl, collectionIDs, attempts);
  }
  let identification = await identifyPage(url, source.finalUrl, source.document, attempts);
  return identification === null ? null : saveIdentification(identification, collectionIDs);
}

// Saves the item the source identifies; a source that no method identifies is saved from
// the fallback metadata when the request gives it.
async function importSource(
  url: string,
  fallback: FallbackMetadata | null,
  collectionIDs: number[],
  attempts: Attempt[],
): Promise<{ source: FetchedSource | null; outcome: ImportOutcome }> {
  let source: FetchedSource | null = null;
  let outcome: ImportOutcome | null = null;
  try {
    source = await fetchSource(url);
    outcome = await identifySource(url, source, collectionIDs, attempts);
  } catch (error) {
    // A source that is neither HTML nor PDF is unidentified, like one that
    // no method names; every other failure stands.
    if (!(error instanceof SourceNotIdentifiedError && fallback !== null)) {
      throw error;
    }
  }
  if (outcome !== null) {
    return { source, outcome };
  }
  if (fallback === null) {
    throw new SourceNotIdentifiedError("No method identified the source: " + url, attempts);
  }
  return { source, outcome: await saveFallback(url, source, fallback, collectionIDs) };
}

export async function handleImportFromUrl(data: RequestData) {
  let url = requireHttpUrl(data.url);
  let fallback =
    data.fallback_metadata === undefined ? null : requireFallbackMetadata(data.fallback_metadata);
  let collectionKeys = Boolean(data.collection_keys)
    ? normalizeStringList(data.collection_keys, "collection_keys")
    : [];
  let collectionIDs = await userCollectionIDs(collectionKeys);

  let attempts: Attempt[] = [];
  let { source, outcome } = await importSource(url, fallback, collectionIDs, attempts);

  return successResult(
    "import_from_url",
    {
      url,
      final_url: source === null ? url : source.finalUrl,
      collection_keys: collectionKeys,
      translator: translatorDetails(outcome.translator),
      attempts,
      attachment_failures: outcome.attachmentFailures,
    },
    {
      item_key: outcome.item.key,
      item_id: outcome.item.id,
      citation_key: await citationKey(outcome.item),
      method: outcome.method,
      existing: outcome.existing,
    },
  );
}
