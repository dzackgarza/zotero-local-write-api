import { conflict, notFound } from "./errors";
import { type JsonPayload } from "./responses";
import { type ActiveZoteroPane } from "./zotero-api";

// Better BibTeX keys a new item from its item notifier, after a delay
// (content/better-bibtex.js, Events.updateCitationKeys). That handler calls
// KeyManager.update and saves the item when it set a key; calling it here
// gives the same key before the response. Without Better BibTeX, Zotero's
// citationKey field is what the item has.
type BetterBibTeXApi = {
  ready: Promise<void>;
  KeyManager: { update(item: Zotero.Item): Zotero.Item | undefined };
};

export async function citationKey(item: Zotero.Item): Promise<string> {
  let betterBibTeX = (Zotero as typeof Zotero & { BetterBibTeX?: BetterBibTeXApi }).BetterBibTeX;
  if (betterBibTeX !== undefined) {
    await betterBibTeX.ready;
    if (betterBibTeX.KeyManager.update(item) !== undefined) {
      await item.saveTx({ skipDateModifiedUpdate: true });
    }
  }
  return item.getField("citationKey");
}

export async function citationKeys(items: Zotero.Item[]): Promise<string[]> {
  let keys: string[] = [];
  for (let item of items) {
    keys.push(await citationKey(item));
  }
  return keys;
}

export function userLibraryID(): number {
  return Zotero.Libraries.userLibraryID;
}

export async function getUserItemOrThrow(itemKey: string) {
  let item = Zotero.Items.getByLibraryAndKey(userLibraryID(), itemKey);
  if (item === false) {
    throw notFound("Item not found: " + itemKey);
  }
  return item;
}

export async function getUserCollectionOrThrow(collectionKey: string) {
  let collection = Zotero.Collections.getByLibraryAndKey(userLibraryID(), collectionKey);
  if (collection === false) {
    throw notFound("Collection not found: " + collectionKey);
  }
  return collection;
}

export function collectionKeyForID(collectionID: number): string {
  // Zotero.Collections.get returns the documented `false` sentinel for an id that no
  // longer resolves. Dropping such an id silently would rewrite the item's collection
  // memberships during an unrelated add/remove, so an unresolvable id fails loudly.
  let collection = Zotero.Collections.get(collectionID);
  if (collection === false) {
    throw notFound("Collection not found for id: " + String(collectionID));
  }
  return collection.key;
}

export function collectionDetails(collection: Zotero.Collection): JsonPayload {
  // parentKey is the documented `false` sentinel when the collection has no parent;
  // zotero-types models only the `string` case, so read through the real runtime type.
  let parentKey = (collection as { parentKey: string | false }).parentKey;
  return {
    collection_key: collection.key,
    collection_name: collection.name,
    parent_key: parentKey === false ? null : parentKey,
  };
}

export async function copyStoredAttachmentFiles(
  sourceAttachment: Zotero.Item,
  newAttachment: Zotero.Item,
): Promise<void> {
  if (!sourceAttachment.isStoredFileAttachment()) {
    return;
  }
  if (!(await sourceAttachment.fileExists())) {
    return;
  }
  let sourceDir = Zotero.Attachments.getStorageDirectory(sourceAttachment);
  let destDir = await Zotero.Attachments.createDirectoryForItem(newAttachment);
  await Zotero.File.copyDirectory(sourceDir, destDir);
}

export async function cloneChildAttachmentToParent(
  sourceAttachment: Zotero.Item,
  parentItemID: number,
): Promise<Zotero.Item> {
  let newAttachment = sourceAttachment.clone(sourceAttachment.libraryID);
  newAttachment.parentID = parentItemID;
  await newAttachment.saveTx();
  await copyStoredAttachmentFiles(sourceAttachment, newAttachment);
  return newAttachment;
}

export async function userCollectionIDs(collectionKeys: string[]): Promise<number[]> {
  let collectionIDs: number[] = [];
  for (let collectionKey of collectionKeys) {
    let collection = await getUserCollectionOrThrow(collectionKey);
    collectionIDs.push(collection.id);
  }
  return collectionIDs;
}

// The collection selected in Zotero's pane, or undefined when the selected row is not
// a collection (a library root, a saved search, Unfiled Items, and so on).
export function selectedCollection(): Zotero.Collection | undefined {
  let pane = Zotero.getActiveZoteroPane() as ActiveZoteroPane | null;
  if (pane === null) {
    throw conflict("No Zotero window is open, so no collection is selected.");
  }
  return pane.getSelectedCollection();
}
