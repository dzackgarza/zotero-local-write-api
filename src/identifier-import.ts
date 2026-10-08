import { badRequest, notFound } from "./errors";
import { type FiledWork, fileWork, saveForTarget, saveWithItemSaver } from "./import-from-url";
import { citationKeys, userCollectionIDs, userLibraryID } from "./library";
import { normalizeStringList, requireNonEmptyString } from "./request-fields";
import { type RequestData, successResult } from "./responses";
import {
  createImportTranslator,
  createTranslateSearch,
  findIdentifiers,
  type Identifier,
  type TranslatorItemJSON,
  type ZoteroTranslateApi,
  type ZoteroTranslateSearchApi,
} from "./zotero-api";

export let BIBTEX_TRANSLATOR_ID = "9cb70025-a888-4a29-a210-93ec52da40d4";

function extractIdentifiers(raw: string): Identifier[] {
  let identifiers = findIdentifiers(raw);
  if (!identifiers.length) {
    throw badRequest("Could not parse identifier");
  }
  return identifiers;
}

// The response fields that name the imported items; the first item is the primary one.
async function importedItemsFields(items: Zotero.Item[]) {
  return {
    item_key: items[0].key,
    item_id: items[0].id,
    item_keys: items.map((item) => item.key),
    item_ids: items.map((item) => item.id),
    titles: items.map((item) => item.getField("title")),
    citation_keys: await citationKeys(items),
  };
}

// The work one BibTeX entry names, as item JSON; the translation saves nothing.
async function translateBibTeX(bibtex: string): Promise<TranslatorItemJSON> {
  let translator = createImportTranslator();
  translator.setTranslator(BIBTEX_TRANSLATOR_ID);
  translator.setString(bibtex);
  let works = await translator.translate({ libraryID: false, saveAttachments: false });
  if (works.length !== 1) {
    throw badRequest("import_bibtex takes exactly one BibTeX entry, found " + works.length);
  }
  return works[0];
}

// Zotero's own import saver (translate.js `Zotero.Translate.Import#_prepareTranslation`):
// the entry's file attachments are stored from their paths.
function saveImportedWork(collectionIDs: number[]) {
  let { ItemSaver } = Zotero.Translate as ZoteroTranslateApi;
  return (json: TranslatorItemJSON) =>
    saveWithItemSaver(
      new ItemSaver({
        libraryID: userLibraryID(),
        collections: collectionIDs.length ? collectionIDs : false,
        attachmentMode: ItemSaver.ATTACHMENT_MODE_FILE,
      }),
      json,
    );
}

export async function handleImportBibTeX(data: RequestData) {
  let bibtex = requireNonEmptyString(data.bibtex, "bibtex");
  let collectionKeys =
    data.collection_keys === undefined
      ? []
      : normalizeStringList(data.collection_keys, "collection_keys");
  let collectionIDs = await userCollectionIDs(collectionKeys);
  let filed = await fileWork(
    await translateBibTeX(bibtex),
    collectionIDs,
    saveImportedWork(collectionIDs),
  );

  return successResult(
    "import_bibtex",
    {
      item_count: 1,
      collection_keys: collectionKeys,
      translator_id: BIBTEX_TRANSLATOR_ID,
      attachment_failures: filed.attachmentFailures,
    },
    { ...(await importedItemsFields([filed.item])), existing: [filed.existing] },
  );
}

async function identifierSearch(identifier: Identifier): Promise<ZoteroTranslateSearchApi> {
  let search = createTranslateSearch();
  search.setIdentifier(identifier);
  let translators = await search.getTranslators();
  if (translators.length === 0) {
    throw notFound("No translator available for identifier: " + JSON.stringify(identifier));
  }
  search.setTranslator(translators);
  return search;
}

// The works an identifier names, as item JSON; the translation saves nothing.
async function translateIdentifier(identifier: Identifier): Promise<TranslatorItemJSON[]> {
  let search = await identifierSearch(identifier);
  let works = await search.translate({ libraryID: false, saveAttachments: false });
  if (works.length === 0) {
    throw notFound("No item found for identifier: " + JSON.stringify(identifier));
  }
  return works;
}

// Each work is filed as import_from_url files it: a work the library holds is answered
// with its entry, and any other work is saved with the attachments Zotero gets for it.
async function fileIdentifiers(
  identifiers: Identifier[],
  collectionIDs: number[],
): Promise<FiledWork[]> {
  let saveFromSearch = saveForTarget({ collectionIDs, storeAttachments: true });
  let filed: FiledWork[] = [];
  for (let identifier of identifiers) {
    for (let work of await translateIdentifier(identifier)) {
      filed.push(await fileWork(work, collectionIDs, saveFromSearch));
    }
  }
  return filed;
}

export async function handleImportByIdentifier(data: RequestData) {
  let raw = requireNonEmptyString(data.identifier, "identifier");
  let collectionKeys =
    data.collection_keys === undefined
      ? []
      : normalizeStringList(data.collection_keys, "collection_keys");
  let collections = await userCollectionIDs(collectionKeys);

  let filed = await fileIdentifiers(extractIdentifiers(raw), collections);
  let items = filed.map((work) => work.item);

  return successResult(
    "import_by_identifier",
    {
      identifier: raw,
      item_count: items.length,
      collection_keys: collectionKeys,
      attachment_failures: filed.flatMap((work) => work.attachmentFailures),
    },
    { ...(await importedItemsFields(items)), existing: filed.map((work) => work.existing) },
  );
}
