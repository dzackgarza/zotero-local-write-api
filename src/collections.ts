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

export async function handleMergeCollections(data: RequestData) {
  let sourceKeys = normalizeStringList(data.source_keys, "source_keys");
  let targetKey = requireNonEmptyString(data.target_key, "target_key");
  if (sourceKeys.includes(targetKey)) {
    throw conflict("Target collection cannot also be a source collection");
  }
  let targetCollection = await getUserCollectionOrThrow(targetKey);
  let movedItems = 0;
  let movedChildren = 0;
  let trashedSources = 0;

  for (let sourceKey of sourceKeys) {
    let sourceCollection = await getUserCollectionOrThrow(sourceKey);
    let descendents = sourceCollection.getDescendents(false, null, false);
    if (descendents.some((d) => d.type === "collection" && d.key === targetKey)) {
      throw conflict("Cannot merge a collection into one of its descendants");
    }

    let childItems = sourceCollection.getChildItems(true, true);
    if (childItems.length) {
      await targetCollection.addItems(childItems);
      movedItems += childItems.length;
    }

    let childCollections = sourceCollection.getChildCollections(false, true);
    for (let childCollection of childCollections) {
      if (childCollection.key === targetKey) {
        continue;
      }
      childCollection.parentKey = targetKey;
      await childCollection.saveTx();
      movedChildren++;
    }

    sourceCollection.deleted = true;
    await sourceCollection.saveTx();
    trashedSources++;
  }

  return successResult("merge_collections", {
    source_keys: sourceKeys,
    target_key: targetKey,
    moved_item_count: movedItems,
    moved_child_collection_count: movedChildren,
    trashed_source_count: trashedSources,
  });
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
