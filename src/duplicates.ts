import { userLibraryID } from "./library";
import { normalizeText } from "./metadata-services";
import { type ItemFieldsApi, type TranslatorItemJSON } from "./zotero-api";

// A creator as Zotero's duplicate finder compares it; an absent firstName is a creator
// known by one name.
type DuplicateCreator = { lastName: string; firstName?: string };

// The fields Zotero's duplicate finder compares; undefined is a field the item lacks.
export type DuplicateKeys = {
  itemType: string;
  title?: string;
  DOI?: string;
  ISBN?: string;
  url?: string;
  date?: string;
  creators: DuplicateCreator[];
};
type ItemValueRow = { itemID: number; value: string };

export function duplicateKeysFromJSON(json: TranslatorItemJSON): DuplicateKeys {
  return {
    itemType: json.itemType,
    title: json.title,
    DOI: json.DOI,
    ISBN: json.ISBN,
    url: json.url,
    date: json.date,
    creators: (json.creators ?? []).map((creator) => ({
      lastName: creator.lastName ?? creator.name ?? "",
      firstName: creator.firstName,
    })),
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

// Whether an ISBN field, which may list several ISBNs, holds the given ISBN-13.
function holdsISBN13(field: string, wanted: string): boolean {
  return field
    .split(/\s+/)
    .map((value) => Zotero.Utilities.cleanISBN(value))
    .some((value) => value !== false && Zotero.Utilities.toISBN13(value) === wanted);
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
  return rows.filter((row) => holdsISBN13(String(row.value), wanted)).map((row) => row.itemID);
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

// What the title rule of Zotero's duplicate finder compares of one item, read as
// `_findDuplicates` reads it: a DOI only when it starts "10.", an ISBN only of a book, and
// the year as the first four characters of the stored multipart date, unless "0000".
type TitleRuleKeys = {
  DOI: string | null;
  ISBN: string | null;
  year: number | null;
  creators: { lastName: string; firstInitial: string }[];
};

function titleRuleKeys(
  itemType: string,
  doi: string,
  isbn: string,
  multipartDate: string,
  creators: DuplicateCreator[],
): TitleRuleKeys {
  let cleanDOI = doi.trim().toUpperCase();
  let cleanISBN = itemType === "book" ? Zotero.Utilities.cleanISBN(isbn) : false;
  let year = multipartDate.slice(0, 4);
  return {
    DOI: cleanDOI.startsWith("10.") ? cleanDOI : null,
    ISBN: cleanISBN === false || cleanISBN === "" ? null : cleanISBN,
    year: year === "" || year === "0000" ? null : Number(year),
    creators: creators.map((creator) => ({
      lastName: normalizeText(creator.lastName),
      firstInitial: normalizeText(creator.firstName ?? "").charAt(0),
    })),
  };
}

function keysTitleRuleKeys(keys: DuplicateKeys): TitleRuleKeys {
  return titleRuleKeys(
    keys.itemType,
    keys.DOI ?? "",
    keys.ISBN ?? "",
    keys.date === undefined ? "" : Zotero.Date.strToMultipart(keys.date),
    keys.creators,
  );
}

function itemTitleRuleKeys(item: Zotero.Item): TitleRuleKeys {
  return titleRuleKeys(
    item.itemType,
    item.getField("DOI"),
    item.getField("ISBN"),
    item.getField("date", true, true),
    item.getCreators().map((creator) => ({
      lastName: creator.lastName,
      firstName: creator.fieldMode === 0 ? creator.firstName : undefined,
    })),
  );
}

// Two items with equal normalized titles are one work unless both have DOIs that differ,
// both have ISBNs that differ, or both have years more than one apart; and they must
// both have no creators or share a creator by last name and first initial. Ported from
// the title comparison of `Zotero.Duplicates.prototype._findDuplicates`
// (chrome/content/zotero/xpcom/duplicates.js), which compares only items already in a
// library and so cannot be called for one unsaved item.
function sameWorkByTitle(a: TitleRuleKeys, b: TitleRuleKeys): boolean {
  if (a.DOI !== null && b.DOI !== null && a.DOI !== b.DOI) {
    return false;
  }
  if (a.ISBN !== null && b.ISBN !== null && a.ISBN !== b.ISBN) {
    return false;
  }
  if (a.year !== null && b.year !== null && Math.abs(a.year - b.year) > 1) {
    return false;
  }
  if (a.creators.length === 0 || b.creators.length === 0) {
    return a.creators.length === b.creators.length;
  }
  return a.creators.some((ac) =>
    b.creators.some((bc) => ac.lastName === bc.lastName && ac.firstInitial === bc.firstInitial),
  );
}

// The title, and every field mapped to it, of each live regular item of the user library.
async function titleRows(): Promise<ItemValueRow[]> {
  let mappedIDs = (Zotero.ItemFields as ItemFieldsApi).getTypeFieldsFromBase("title");
  let titleIDs = [requireFieldID("title"), ...(mappedIDs === false ? [] : mappedIDs)];
  let sql =
    "SELECT itemID, value FROM items JOIN itemData USING (itemID) " +
    "JOIN itemDataValues USING (valueID) " +
    "WHERE libraryID=? AND fieldID IN (" +
    titleIDs.map(() => "?").join() +
    ") AND itemTypeID NOT IN (?, ?) " +
    "AND itemID NOT IN (SELECT itemID FROM deletedItems)";
  let rows = await Zotero.DB.queryAsync(sql, [
    userLibraryID(),
    ...titleIDs,
    requireItemTypeID("attachment"),
    requireItemTypeID("note"),
  ]);
  if (rows === undefined) {
    throw new Error("Zotero answered a SELECT with no rows array");
  }
  return rows as ItemValueRow[];
}

async function titleCreatorYearMatches(keys: DuplicateKeys): Promise<number[]> {
  let title = normalizeText(keys.title ?? "");
  if (title === "") {
    return [];
  }
  let wanted = keysTitleRuleKeys(keys);
  let matches: number[] = [];
  for (let row of await titleRows()) {
    if (normalizeText(String(row.value)) !== title) {
      continue;
    }
    let candidate = await Zotero.Items.getAsync(row.itemID);
    if (candidate !== false && sameWorkByTitle(wanted, itemTitleRuleKeys(candidate))) {
      matches.push(row.itemID);
    }
  }
  return matches;
}

// The item already in the library that is this work, by the rules of Zotero's
// duplicate finder (chrome/content/zotero/xpcom/duplicates.js): equal DOI, equal
// ISBN between books, or equal title with agreeing creators and year. A URL counts
// only together with an equal title, because one landing URL can serve different
// papers over time.
export async function findExistingItem(keys: DuplicateKeys): Promise<Zotero.Item | null> {
  let matchIDs = [
    ...(await doiMatches(keys)),
    ...(await isbnMatches(keys)),
    ...(await titleCreatorYearMatches(keys)),
    ...(await urlAndTitleMatches(keys)),
  ];
  for (let itemID of [...new Set(matchIDs)].sort((a, b) => a - b)) {
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
