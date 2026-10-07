import { userLibraryID } from "./library";
import { normalizeText } from "./metadata-services";
import { type ItemFieldsApi, type TranslatorItemJSON } from "./zotero-api";

// The fields Zotero's duplicate finder compares; undefined is a field the item lacks.
type DuplicateKeys = {
  itemType: string;
  title?: string;
  DOI?: string;
  ISBN?: string;
  url?: string;
};
type ItemValueRow = { itemID: number; value: string };

export function duplicateKeysFromJSON(json: TranslatorItemJSON): DuplicateKeys {
  return {
    itemType: json.itemType,
    title: json.title,
    DOI: json.DOI,
    ISBN: json.ISBN,
    url: json.url,
  };
}

// Zotero stores a field an item lacks as "".
function storedField(
  item: Zotero.Item,
  field: "title" | "DOI" | "ISBN" | "url",
): string | undefined {
  let value = item.getField(field);
  return value === "" ? undefined : value;
}

export function duplicateKeysFromItem(item: Zotero.Item): DuplicateKeys {
  return {
    itemType: item.itemType,
    title: storedField(item, "title"),
    DOI: storedField(item, "DOI"),
    ISBN: storedField(item, "ISBN"),
    url: storedField(item, "url"),
  };
}

function requireFieldID(field: string): number {
  let fieldID = (Zotero.ItemFields as ItemFieldsApi).getID(field);
  if (fieldID === false) {
    throw new Error("Zotero has no field " + field);
  }
  return fieldID;
}

function requireItemTypeID(itemType: string): number {
  let itemTypeID = Zotero.ItemTypes.getID(itemType);
  if (itemTypeID === false) {
    throw new Error("Zotero has no item type " + itemType);
  }
  return itemTypeID;
}

// The value of the field in each live item of the user library, of the given type if any.
// queryAsync answers a SELECT with its rows; undefined is only for other statements.
async function fieldRows(field: string, itemType: string | null): Promise<ItemValueRow[]> {
  let params: number[] = [userLibraryID(), requireFieldID(field)];
  let sql =
    "SELECT itemID, value FROM items JOIN itemData USING (itemID) " +
    "JOIN itemDataValues USING (valueID) " +
    "WHERE libraryID=? AND fieldID=? " +
    "AND itemID NOT IN (SELECT itemID FROM deletedItems)";
  if (itemType !== null) {
    sql += " AND itemTypeID=?";
    params.push(requireItemTypeID(itemType));
  }
  let rows = await Zotero.DB.queryAsync(sql, params);
  if (rows === undefined) {
    throw new Error("Zotero answered a SELECT with no rows array");
  }
  return rows as ItemValueRow[];
}

async function doiMatches(keys: DuplicateKeys): Promise<number[]> {
  let doi = keys.DOI === undefined ? null : Zotero.Utilities.cleanDOI(keys.DOI);
  if (doi === null || doi === "") {
    return [];
  }
  let wanted = doi.toUpperCase();
  let rows = await fieldRows("DOI", null);
  return rows.filter((row) => row.value.trim().toUpperCase() === wanted).map((row) => row.itemID);
}

async function isbnMatches(keys: DuplicateKeys): Promise<number[]> {
  if (keys.itemType !== "book" || keys.ISBN === undefined) {
    return [];
  }
  let isbn = Zotero.Utilities.cleanISBN(keys.ISBN);
  if (isbn === false) {
    return [];
  }
  let wanted = Zotero.Utilities.toISBN13(isbn);
  let rows = await fieldRows("ISBN", "book");
  return rows
    .filter((row) =>
      String(row.value)
        .split(/\s+/)
        .map((value) => Zotero.Utilities.cleanISBN(value))
        .some((value) => value !== false && Zotero.Utilities.toISBN13(value) === wanted),
    )
    .map((row) => row.itemID);
}

async function urlAndTitleMatches(keys: DuplicateKeys): Promise<number[]> {
  if (keys.url === undefined || keys.title === undefined) {
    return [];
  }
  let title = normalizeText(keys.title);
  if (title === "") {
    return [];
  }
  let matches: number[] = [];
  for (let row of await fieldRows("url", null)) {
    if (row.value !== keys.url) {
      continue;
    }
    let candidate = await Zotero.Items.getAsync(row.itemID);
    if (candidate !== false && normalizeText(candidate.getField("title")) === title) {
      matches.push(row.itemID);
    }
  }
  return matches;
}

// The item already in the library that is this work, by the rules of Zotero's
// duplicate finder (chrome/content/zotero/xpcom/duplicates.js): equal DOI, or
// equal ISBN between books. A URL counts only together with an equal title,
// because one landing URL can serve different papers over time.
export async function findExistingItem(
  keys: DuplicateKeys,
  excludeID: number | null,
): Promise<Zotero.Item | null> {
  let matchIDs = [
    ...(await doiMatches(keys)),
    ...(await isbnMatches(keys)),
    ...(await urlAndTitleMatches(keys)),
  ];
  for (let itemID of [...new Set(matchIDs)].sort((a, b) => a - b)) {
    if (itemID === excludeID) {
      continue;
    }
    let item = await Zotero.Items.getAsync(itemID);
    if (item !== false && item.isRegularItem()) {
      return item;
    }
  }
  return null;
}

// An existing item is returned as the result and gains the requested
// collections; nothing else about it changes.
export async function fileExistingItem(item: Zotero.Item, collectionIDs: number[]): Promise<void> {
  let missing = collectionIDs.filter((id) => !item.getCollections().includes(id));
  if (missing.length === 0) {
    return;
  }
  for (let id of missing) {
    item.addToCollection(id);
  }
  await item.saveTx();
}
