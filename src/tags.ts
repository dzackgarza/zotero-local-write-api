import { notFound } from "./errors";
import { getUserItemOrThrow, userLibraryID } from "./library";
import { normalizeStringList, requireNonEmptyString } from "./request-fields";
import { type RequestData, successResult } from "./responses";
import { removeTagsFromUserLibrary } from "./zotero-api";

export type TagEntry = { tag: string; type: number };

export async function handleSetItemTags(data: RequestData) {
  let itemKey = requireNonEmptyString(data.item_key, "item_key");
  let tags = normalizeStringList(data.tags, "tags");
  let item = await getUserItemOrThrow(itemKey);
  item.setTags(tags);
  await item.saveTx();
  return successResult("set_item_tags", {
    item_key: itemKey,
    tags: tags,
    tag_count: tags.length,
  });
}

export async function handleRenameTag(data: RequestData) {
  let oldName = requireNonEmptyString(data.old_name, "old_name");
  let newName = requireNonEmptyString(data.new_name, "new_name");
  await Zotero.Tags.rename(userLibraryID(), oldName, newName);
  return successResult("rename_tag", {
    old_name: oldName,
    new_name: newName,
  });
}

export async function handleMergeTags(data: RequestData) {
  let sourceTags = normalizeStringList(data.source_tags, "source_tags");
  let targetTag = requireNonEmptyString(data.target_tag, "target_tag");
  for (let sourceTag of sourceTags) {
    if (sourceTag === targetTag) {
      continue;
    }
    await Zotero.Tags.rename(userLibraryID(), sourceTag, targetTag);
  }
  return successResult("merge_tags", {
    source_tags: sourceTags,
    target_tag: targetTag,
  });
}

export async function handleDeleteTag(data: RequestData) {
  // NFC for the same reason as normalizeStringList: Zotero stores the
  // normalized form, so a non-NFC tag_name would miss getID and 404 on a tag
  // that does exist.
  let tagName = requireNonEmptyString(data.tag_name, "tag_name").normalize("NFC");
  let tagID = Zotero.Tags.getID(tagName);
  if (tagID === false || tagID === 0) {
    throw notFound("Tag not found: " + tagName);
  }

  // Remove the tag from every item that carries it before removing it from the
  // library, and report how many items changed.
  let search = new Zotero.Search({ libraryID: userLibraryID() });
  search.addCondition("tag", "is", tagName);
  let itemIDs = await search.search();

  // Zotero.Tags.removeFromLibrary already detaches the tag from every item that
  // carries it. Doing that here first left it with an empty item set, and its
  // UPDATE then built "WHERE itemID IN ()" and failed with "Parameter 1 is
  // undefined". The search above is kept only to report how many items changed.
  let modifiedCount = itemIDs.length;

  await removeTagsFromUserLibrary(userLibraryID(), [tagID]);

  return successResult("delete_tag", {
    tag_name: tagName,
    modified_item_count: modifiedCount,
  });
}

export async function handleDeleteUnusedTags(_data: RequestData) {
  Zotero.Prefs.set("purge.tags", true);
  await Zotero.DB.executeTransaction(async function () {
    await Zotero.Tags.purge();
  });
  return successResult("delete_unused_tags", {});
}

export async function handleAddItemTags(data: RequestData) {
  let itemKey = requireNonEmptyString(data.item_key, "item_key");
  let tagsToAdd = normalizeStringList(data.tags, "tags");
  let item = await getUserItemOrThrow(itemKey);
  let existing = item.getTags() as TagEntry[];
  let existingNames = new Set(existing.map((t) => t.tag));
  let added: string[] = [];
  for (let tag of tagsToAdd) {
    if (!existingNames.has(tag)) {
      existing.push({ tag: tag, type: 0 });
      existingNames.add(tag);
      added.push(tag);
    }
  }
  item.setTags(existing);
  await item.saveTx();
  return successResult("add_item_tags", {
    item_key: itemKey,
    added_tags: added,
    total_tag_count: existing.length,
  });
}

export async function handleRemoveItemTags(data: RequestData) {
  let itemKey = requireNonEmptyString(data.item_key, "item_key");
  let tagsToRemove = new Set(normalizeStringList(data.tags, "tags"));
  let item = await getUserItemOrThrow(itemKey);
  let allTags = item.getTags() as TagEntry[];
  let removedCount = allTags.filter((t) => tagsToRemove.has(t.tag)).length;
  let filtered = allTags.filter((t) => !tagsToRemove.has(t.tag));
  item.setTags(filtered);
  await item.saveTx();
  return successResult("remove_item_tags", {
    item_key: itemKey,
    removed_count: removedCount,
    remaining_tag_count: filtered.length,
  });
}
