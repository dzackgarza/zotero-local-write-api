import { duplicateKeysFromJSON, fileExistingItem } from "./duplicates";
import { type FallbackMetadata, requireFallbackMetadata, saveFallback } from "./fallback-metadata";
import { identifyPage } from "./identify-page";
import { citationKey, userCollectionIDs, userLibraryID } from "./library";
import {
  findExistingOutsideRecognition,
  hasStoredPdf,
  recognizePdf,
  storePdf,
} from "./pdf-recognition";
import { normalizeStringList } from "./request-fields";
import { type RequestData, successResult } from "./responses";
import { fetchSource, requireHttpUrl } from "./source-fetch";
import { identifierText, identifyByIdentifier } from "./source-methods";
import {
  type AttachmentFailure,
  type Attempt,
  existingOutcome,
  type FetchedSource,
  type Identification,
  type ImportOutcome,
  recordAttempt,
  type SourceMethod,
  SourceNotIdentifiedError,
  translatorDetails,
} from "./source-results";
import { type TranslatorItemJSON, type ZoteroTranslateApi } from "./zotero-api";

// The Zotero Connector's save mode: the translator's attachments are stored, and an
// open-access PDF is looked up when the translator gives none.
function connectorItemSaver(collectionIDs: number[]) {
  let translateApi = Zotero.Translate as ZoteroTranslateApi;
  return new translateApi.ItemSaver({
    libraryID: userLibraryID(),
    collections: collectionIDs.length ? collectionIDs : false,
    attachmentMode: translateApi.ItemSaver.ATTACHMENT_MODE_DOWNLOAD,
  });
}

function attachmentFailure(
  attachment: { title?: string; url?: string },
  error: Error | undefined,
): AttachmentFailure {
  return {
    title: attachment.title === undefined ? null : attachment.title,
    url: attachment.url === undefined ? null : attachment.url,
    error: String(error),
  };
}

// Saves one translated item, and records each attachment that Zotero could not store.
async function saveTranslatedItem(
  json: TranslatorItemJSON,
  collectionIDs: number[],
): Promise<{ item: Zotero.Item; attachmentFailures: AttachmentFailure[] }> {
  let attachmentFailures: AttachmentFailure[] = [];
  let items = await connectorItemSaver(collectionIDs).saveItems(
    [json],
    (attachment, progress, error) => {
      if (progress === false) {
        attachmentFailures.push(attachmentFailure(attachment, error));
      }
    },
  );
  if (items.length !== 1) {
    throw new Error("import_from_url saved " + items.length + " items instead of one");
  }
  return { item: items[0], attachmentFailures };
}

async function saveIdentification(
  identification: Identification & { method: SourceMethod },
  collectionIDs: number[],
): Promise<ImportOutcome> {
  let { method, translator } = identification;
  let existing = await findExistingOutsideRecognition(duplicateKeysFromJSON(identification.json));
  if (existing) {
    await fileExistingItem(existing, collectionIDs);
    return existingOutcome(existing, method, translator);
  }
  let saved = await saveTranslatedItem(identification.json, collectionIDs);
  return { ...saved, existing: false, method, translator };
}

// A PDF that Zotero's recognizer does not identify is saved from an identifier in its URLs,
// with the PDF stored under the new item.
async function importPdfByIdentifier(
  requestedUrl: string,
  finalUrl: string,
  collectionIDs: number[],
  attempts: Attempt[],
): Promise<ImportOutcome | null> {
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
  return importPdfByIdentifier(requestedUrl, finalUrl, collectionIDs, attempts);
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

// The fetched source and the item a method saved from it; both are null when the source
// is not identified and the request gives fallback metadata.
// A source that is neither HTML nor PDF is unidentified, like one that no method names;
// every other failure stands.
async function fetchAndIdentify(
  url: string,
  fallback: FallbackMetadata | null,
  collectionIDs: number[],
  attempts: Attempt[],
): Promise<{ source: FetchedSource | null; outcome: ImportOutcome | null }> {
  let source: FetchedSource | null = null;
  try {
    source = await fetchSource(url);
    return { source, outcome: await identifySource(url, source, collectionIDs, attempts) };
  } catch (error) {
    if (!(error instanceof SourceNotIdentifiedError && fallback !== null)) {
      throw error;
    }
    return { source, outcome: null };
  }
}

// Saves the item the source identifies; a source that no method identifies is saved from
// the fallback metadata when the request gives it.
async function importSource(
  url: string,
  fallback: FallbackMetadata | null,
  collectionIDs: number[],
  attempts: Attempt[],
): Promise<{ source: FetchedSource | null; outcome: ImportOutcome }> {
  let { source, outcome } = await fetchAndIdentify(url, fallback, collectionIDs, attempts);
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
  let collectionKeys =
    data.collection_keys === undefined
      ? []
      : normalizeStringList(data.collection_keys, "collection_keys");
  let collectionIDs = await userCollectionIDs(collectionKeys);

  let attempts: Attempt[] = [];
  let { source, outcome } = await importSource(url, fallback, collectionIDs, attempts);

  return successResult(
    "import_from_url",
    importDetails(url, collectionKeys, source, outcome, attempts),
    await importedItemFields(outcome),
  );
}

// The import_from_url response details: what was asked, what was fetched, and each attempt.
function importDetails(
  url: string,
  collectionKeys: string[],
  source: FetchedSource | null,
  outcome: ImportOutcome,
  attempts: Attempt[],
) {
  return {
    url,
    final_url: source === null ? url : source.finalUrl,
    collection_keys: collectionKeys,
    translator: translatorDetails(outcome.translator),
    attempts,
    attachment_failures: outcome.attachmentFailures,
  };
}

// The import_from_url response fields that name the saved item and how it was found.
async function importedItemFields(outcome: ImportOutcome) {
  return {
    item_key: outcome.item.key,
    item_id: outcome.item.id,
    citation_key: await citationKey(outcome.item),
    method: outcome.method,
    existing: outcome.existing,
  };
}
