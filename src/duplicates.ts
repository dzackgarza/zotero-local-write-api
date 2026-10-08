import { userLibraryID } from "./library";
import { normalizeText } from "./metadata-services";
import { type CreatorJSON, type ItemFieldsApi, type TranslatorItemJSON } from "./zotero-api";

// The fields Zotero's duplicate finder compares; undefined is a field the item lacks.
export type DuplicateKeys = {
  itemType: string;
  title?: string;
  DOI?: string;
  ISBN?: string;
  url?: string;
  date?: string;
  creators?: CreatorJSON[];
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
    creators: json.creators,
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

// A creator as the title rule compares it: the normalized last name, and the first
// initial, which is "" for a single-field creator, as in `_findDuplicates`.
type TitleRuleCreator = { lastName: string; firstInitial: string };

// What the title rule of Zotero's duplicate finder compares of one item, read as
// `_findDuplicates` reads it: a DOI only when it starts "10.", an ISBN only of a book, and
// the year as the first four characters of the stored multipart date, unless "0000".
// Null is a value the item lacks, which the rule does not compare; creators are null
// for an item with no creators.
type TitleRuleKeys = {
  DOI: string | null;
  ISBN: string | null;
  year: number | null;
  creators: TitleRuleCreator[] | null;
};

// Zotero stores an empty field as "", and item JSON omits it; both are a missing value.
function titleRuleDOI(doi: string | undefined): string | null {
  if (doi === undefined) {
    return null;
  }
  let cleanDOI = doi.trim().toUpperCase();
  return cleanDOI.startsWith("10.") ? cleanDOI : null;
}

function titleRuleISBN(itemType: string, isbn: string | undefined): string | null {
  if (itemType !== "book" || isbn === undefined) {
    return null;
  }
  let cleanISBN = Zotero.Utilities.cleanISBN(isbn);
  return cleanISBN === false || cleanISBN === "" ? null : cleanISBN;
}

function titleRuleYear(multipartDate: string | undefined): number | null {
  if (multipartDate === undefined) {
    return null;
  }
  let year = multipartDate.slice(0, 4);
  return year === "" || year === "0000" ? null : Number(year);
}

function titleRuleCreator(creator: CreatorJSON): TitleRuleCreator {
  if ("name" in creator) {
    return { lastName: normalizeText(creator.name), firstInitial: "" };
  }
  let firstInitial =
    creator.firstName === undefined ? "" : normalizeText(creator.firstName).charAt(0);
  return { lastName: normalizeText(creator.lastName), firstInitial };
}

function titleRuleCreators(creators: CreatorJSON[] | undefined): TitleRuleCreator[] | null {
  if (creators === undefined || creators.length === 0) {
    return null;
  }
  return creators.map(titleRuleCreator);
}

function keysTitleRuleKeys(keys: DuplicateKeys): TitleRuleKeys {
  return {
    DOI: titleRuleDOI(keys.DOI),
    ISBN: titleRuleISBN(keys.itemType, keys.ISBN),
    year: titleRuleYear(
      keys.date === undefined ? undefined : Zotero.Date.strToMultipart(keys.date),
    ),
    creators: titleRuleCreators(keys.creators),
  };
}

// A stored creator in fieldMode 1 is a single-field name held as its lastName.
function itemCreatorJSON(creator: _ZoteroTypes.Item.Creator): CreatorJSON {
  if (creator.fieldMode === 0) {
    return { firstName: creator.firstName, lastName: creator.lastName };
  }
  return { name: creator.lastName };
}

function itemTitleRuleKeys(item: Zotero.Item): TitleRuleKeys {
  return {
    DOI: titleRuleDOI(item.getField("DOI")),
    ISBN: titleRuleISBN(item.itemType, item.getField("ISBN")),
    year: titleRuleYear(item.getField("date", true, true)),
    creators: titleRuleCreators(item.getCreators().map(itemCreatorJSON)),
  };
}

// Whether both items have the value and the values differ.
function bothPresentAndDifferent(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a !== b;
}

// Whether both items have a year and the years are more than one apart.
function yearsApart(a: number | null, b: number | null): boolean {
  return a !== null && b !== null && Math.abs(a - b) > 1;
}

// Whether both items have no creators, or share one by last name and first initial.
function creatorsAgree(a: TitleRuleCreator[] | null, b: TitleRuleCreator[] | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.some((ac) =>
    b.some((bc) => ac.lastName === bc.lastName && ac.firstInitial === bc.firstInitial),
  );
}

// Two items with equal normalized titles are one work unless both have DOIs that differ,
// both have ISBNs that differ, or both have years more than one apart; and they must
// both have no creators or share a creator by last name and first initial. Ported from
// the title comparison of `Zotero.Duplicates.prototype._findDuplicates`
// (chrome/content/zotero/xpcom/duplicates.js), which compares only items already in a
// library and so cannot be called for one unsaved item.
function sameWorkByTitle(a: TitleRuleKeys, b: TitleRuleKeys): boolean {
  if (
    bothPresentAndDifferent(a.DOI, b.DOI) ||
    bothPresentAndDifferent(a.ISBN, b.ISBN) ||
    yearsApart(a.year, b.year)
  ) {
    return false;
  }
  return creatorsAgree(a.creators, b.creators);
}

// The fields of every item type that map to the base field. Zotero maps item type fields
// to "title", so false, which says no field maps to it, is a broken Zotero schema.
function requireMappedFieldIDs(baseField: string): number[] {
  let fieldIDs = (Zotero.ItemFields as ItemFieldsApi).getTypeFieldsFromBase(baseField);
  if (fieldIDs === false) {
    throw new Error("Zotero maps no item type field to " + baseField);
  }
  return fieldIDs;
}

// The title, and every field mapped to it, of each live regular item of the user library.
async function titleRows(): Promise<ItemValueRow[]> {
  let titleIDs = [requireFieldID("title"), ...requireMappedFieldIDs("title")];
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
  // A work with no title, or one that normalizes to nothing, has no title to compare.
  if (keys.title === undefined) {
    return [];
  }
  let title = normalizeText(keys.title);
  if (title === "") {
    return [];
  }
  return sameWorkTitleMatches(title, keysTitleRuleKeys(keys));
}

// The items whose normalized title is the given one and that are the wanted work.
async function sameWorkTitleMatches(title: string, wanted: TitleRuleKeys): Promise<number[]> {
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
