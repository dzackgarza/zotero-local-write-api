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

function requireTagID(tagName: string): number {
  let tagID = Zotero.Tags.getID(tagName);
  if (tagID === false || tagID === 0) {
    throw notFound("Tag not found: " + tagName);
  }
  return tagID;
}

// The number of items in the user library that carry the tag.
async function taggedItemCount(tagName: string): Promise<number> {
  let search = new Zotero.Search({ libraryID: userLibraryID() });
  search.addCondition("tag", "is", tagName);
  return (await search.search()).length;
}

// NFC for the same reason as normalizeStringList: Zotero stores the
// normalized form, so a non-NFC tag_name would miss getID and 404 on a tag
// that does exist.
// Zotero.Tags.removeFromLibrary already detaches the tag from every item that
// carries it. Doing that here first left it with an empty item set, and its
// UPDATE then built "WHERE itemID IN ()" and failed with "Parameter 1 is
// undefined". The items are counted first only to report how many items changed.
export async function handleDeleteTag(data: RequestData) {
  let tagName = requireNonEmptyString(data.tag_name, "tag_name").normalize("NFC");
  let tagID = requireTagID(tagName);
  let modifiedCount = await taggedItemCount(tagName);
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

// Zotero.Item.addTag returns false when the item already carries the tag as a
// manual tag. It makes an automatic tag of the same name manual and returns
// true, so that tag is reported as added.
export async function handleAddItemTags(data: RequestData) {
  let itemKey = requireNonEmptyString(data.item_key, "item_key");
  let tagsToAdd = normalizeStringList(data.tags, "tags");
  let item = await getUserItemOrThrow(itemKey);
  let added = tagsToAdd.filter((tag) => item.addTag(tag));
  await item.saveTx();
  return successResult("add_item_tags", {
    item_key: itemKey,
    added_tags: added,
    total_tag_count: item.getTags().length,
  });
}

export async function handleRemoveItemTags(data: RequestData) {
  let itemKey = requireNonEmptyString(data.item_key, "item_key");
  let tagsToRemove = normalizeStringList(data.tags, "tags");
  let item = await getUserItemOrThrow(itemKey);
  let removedCount = tagsToRemove.filter((tag) => item.removeTag(tag)).length;
  await item.saveTx();
  return successResult("remove_item_tags", {
    item_key: itemKey,
    removed_count: removedCount,
    remaining_tag_count: item.getTags().length,
  });
}
