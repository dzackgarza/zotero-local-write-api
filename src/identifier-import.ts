import { badRequest, notFound } from "./errors";
import { citationKeys, userCollectionIDs, userLibraryID } from "./library";
import { normalizeStringList, requireNonEmptyString } from "./request-fields";
import { type RequestData, successResult } from "./responses";
import {
  createImportTranslator,
  createTranslateSearch,
  findIdentifiers,
  type Identifier,
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

function requireImportedItems(value: unknown, operation: string): Zotero.Item[] {
  if (!Array.isArray(value)) {
    throw new Error(operation + " did not return an item array");
  }
  for (let item of value) {
    if (typeof item !== "object" || item === null) {
      throw new Error(operation + " returned a non-object item");
    }
    let candidate = item as { key?: unknown; id?: unknown };
    if (typeof candidate.key !== "string" || typeof candidate.id !== "number") {
      throw new Error(operation + " returned an item without key/id");
    }
  }
  return value as Zotero.Item[];
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

// Imports one BibTeX entry into the given collections.
async function translateBibTeX(bibtex: string, collectionIDs: number[]): Promise<Zotero.Item[]> {
  let translator = createImportTranslator();
  translator.setTranslator(BIBTEX_TRANSLATOR_ID);
  translator.setString(bibtex);
  let items = requireImportedItems(
    await translator.translate({
      libraryID: userLibraryID(),
      collections: collectionIDs,
      saveAttachments: true,
    }),
    "import_bibtex",
  );
  if (items.length !== 1) {
    throw new Error("import_bibtex must create exactly one Zotero item");
  }
  return items;
}

export async function handleImportBibTeX(data: RequestData) {
  let bibtex = requireNonEmptyString(data.bibtex, "bibtex");
  let collectionKeys = Boolean(data.collection_keys)
    ? normalizeStringList(data.collection_keys, "collection_keys")
    : [];
  let items = await translateBibTeX(bibtex, await userCollectionIDs(collectionKeys));

  return successResult(
    "import_bibtex",
    {
      item_count: items.length,
      collection_keys: collectionKeys,
      translator_id: BIBTEX_TRANSLATOR_ID,
    },
    await importedItemsFields(items),
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

async function translateIdentifier(
  identifier: Identifier,
  collections: number[] | false,
): Promise<Zotero.Item[]> {
  let search = await identifierSearch(identifier);
  let items = await search.translate({
    libraryID: userLibraryID(),
    collections: collections,
    saveAttachments: true,
  });
  if (items === false || items.length === 0) {
    throw notFound("No item found for identifier: " + JSON.stringify(identifier));
  }
  return items;
}

async function translateIdentifiers(
  identifiers: Identifier[],
  collections: number[],
): Promise<Zotero.Item[]> {
  let items: Zotero.Item[] = [];
  for (let identifier of identifiers) {
    items.push(...(await translateIdentifier(identifier, collections)));
  }
  return items;
}

export async function handleImportByIdentifier(data: RequestData) {
  let raw = requireNonEmptyString(data.identifier, "identifier");
  let collectionKeys = Boolean(data.collection_keys)
    ? normalizeStringList(data.collection_keys, "collection_keys")
    : [];
  let collections = await userCollectionIDs(collectionKeys);

  let items = await translateIdentifiers(extractIdentifiers(raw), collections);

  return successResult(
    "import_by_identifier",
    {
      identifier: raw,
      item_count: items.length,
      collection_keys: collectionKeys,
    },
    await importedItemsFields(items),
  );
}
