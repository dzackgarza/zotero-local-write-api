import { conflict, notFound } from "./errors";
import {
  collectionDetails,
  collectionKeyForID,
  getUserCollectionOrThrow,
  getUserItemOrThrow,
  selectedCollection,
  userLibraryID,
} from "./library";
import { normalizeStringList, requireNonEmptyString } from "./request-fields";
import { type JsonPayload, type RequestData, successResult } from "./responses";
import { setCollectionParentKey } from "./zotero-api";

export async function handleSetItemCollections(data: RequestData) {
  let itemKey = requireNonEmptyString(data.item_key, "item_key");
  let collectionKeys = normalizeStringList(data.collection_keys, "collection_keys");
  for (let collectionKey of collectionKeys) {
    await getUserCollectionOrThrow(collectionKey);
  }
  let item = await getUserItemOrThrow(itemKey);
  item.setCollections(collectionKeys);
  await item.saveTx();
  return successResult("set_item_collections", {
    item_key: itemKey,
    collection_keys: collectionKeys,
  });
}

export async function handleTrashCollection(data: RequestData) {
  let collectionKey = requireNonEmptyString(data.collection_key, "collection_key");
  let collection = await getUserCollectionOrThrow(collectionKey);
  collection.deleted = true;
  await collection.saveTx();
  return successResult("trash_collection", collectionDetails(collection));
}

export async function handleCreateCollection(data: RequestData) {
  let name = requireNonEmptyString(data.name, "name");
  let parentKey: string | null = null;
  if (typeof data.parent_key === "string" && data.parent_key.trim()) {
    parentKey = data.parent_key.trim();
    await getUserCollectionOrThrow(parentKey);
  }

  let collection = new Zotero.Collection({ libraryID: userLibraryID(), name });
  if (parentKey !== null) {
    collection.parentKey = parentKey;
  }
  await collection.saveTx();

  return successResult("create_collection", collectionDetails(collection));
}

export async function handleRenameCollection(data: RequestData) {
  let collectionKey = requireNonEmptyString(data.collection_key, "collection_key");
  let newName = requireNonEmptyString(data.new_name, "new_name");
  let collection = await getUserCollectionOrThrow(collectionKey);
  collection.name = newName;
  await collection.saveTx();

  return successResult("rename_collection", collectionDetails(collection));
}

export async function handleMoveCollection(data: RequestData) {
  let collectionKey = requireNonEmptyString(data.collection_key, "collection_key");
  let collection = await getUserCollectionOrThrow(collectionKey);
  let newParentKey: string | null = null;
  if (typeof data.new_parent_key === "string" && data.new_parent_key.trim()) {
    newParentKey = data.new_parent_key.trim();
    await getUserCollectionOrThrow(newParentKey);
  }
  // `false` is Zotero's documented "no parent" sentinel when no new parent was given.
  setCollectionParentKey(collection, newParentKey === null ? false : newParentKey);
  await collection.saveTx();

  return successResult("move_collection", collectionDetails(collection));
}

type MergeCounts = { movedItems: number; movedChildren: number; trashedSources: number };

export async function handleMergeCollections(data: RequestData) {
  let sourceKeys = normalizeStringList(data.source_keys, "source_keys");
  let targetKey = requireNonEmptyString(data.target_key, "target_key");
  if (sourceKeys.includes(targetKey)) {
    throw conflict("Target collection cannot also be a source collection");
  }
  let targetCollection = await getUserCollectionOrThrow(targetKey);
  let counts: MergeCounts = { movedItems: 0, movedChildren: 0, trashedSources: 0 };
  for (let sourceKey of sourceKeys) {
    await mergeSourceInto(sourceKey, targetCollection, counts);
  }
  return successResult("merge_collections", {
    source_keys: sourceKeys,
    target_key: targetKey,
    moved_item_count: counts.movedItems,
    moved_child_collection_count: counts.movedChildren,
    trashed_source_count: counts.trashedSources,
  });
}

async function mergeSourceInto(
  sourceKey: string,
  targetCollection: Zotero.Collection,
  counts: MergeCounts,
) {
  let sourceCollection = await getUserCollectionOrThrow(sourceKey);
  // Trashed descendants count too: getChildCollections below also returns trashed
  // children, so the target can never be among the children that are re-parented.
  let descendents = sourceCollection.getDescendents(false, "collection", true);
  if (descendents.some((d) => d.key === targetCollection.key)) {
    throw conflict("Cannot merge a collection into one of its descendants");
  }
  await moveChildren(sourceCollection, targetCollection, counts);
  sourceCollection.deleted = true;
  await sourceCollection.saveTx();
  counts.trashedSources++;
}

async function moveChildren(
  sourceCollection: Zotero.Collection,
  targetCollection: Zotero.Collection,
  counts: MergeCounts,
) {
  let childItems = sourceCollection.getChildItems(true, true);
  if (childItems.length) {
    await targetCollection.addItems(childItems);
    counts.movedItems += childItems.length;
  }
  for (let childCollection of sourceCollection.getChildCollections(false, true)) {
    childCollection.parentKey = targetCollection.key;
    await childCollection.saveTx();
    counts.movedChildren++;
  }
}

export async function handleAddItemToCollection(data: RequestData) {
  let itemKey = requireNonEmptyString(data.item_key, "item_key");
  let collectionKey = requireNonEmptyString(data.collection_key, "collection_key");
  let item = await getUserItemOrThrow(itemKey);
  let collection = await getUserCollectionOrThrow(collectionKey);
  let currentKeys = item.getCollections().map(collectionKeyForID);
  if (!currentKeys.includes(collectionKey)) {
    item.setCollections([...currentKeys, collectionKey]);
    await item.saveTx();
  }
  return successResult("add_item_to_collection", {
    item_key: itemKey,
    collection_key: collectionKey,
    collection_name: collection.name,
  });
}

export async function handleRemoveItemFromCollection(data: RequestData) {
  let itemKey = requireNonEmptyString(data.item_key, "item_key");
  let collectionKey = requireNonEmptyString(data.collection_key, "collection_key");
  let item = await getUserItemOrThrow(itemKey);
  let collection = await getUserCollectionOrThrow(collectionKey);
  let currentKeys = item
    .getCollections()
    .map(collectionKeyForID)
    .filter((k) => k !== collectionKey);
  item.setCollections(currentKeys);
  await item.saveTx();
  return successResult("remove_item_from_collection", {
    item_key: itemKey,
    collection_key: collectionKey,
    collection_name: collection.name,
  });
}

export function handleGetSelectedCollection(): JsonPayload {
  let collection = selectedCollection();
  if (!collection) {
    throw notFound("No Collection selected.");
  }
  return successResult("get_selected_collection", {
    collection_key: collection.key,
    collection_name: collection.name,
  });
}
