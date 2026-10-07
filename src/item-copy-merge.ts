import { conflict } from "./errors";
import {
  cloneChildAttachmentToParent,
  copyStoredAttachmentFiles,
  getUserItemOrThrow,
} from "./library";
import { requireNonEmptyString } from "./request-fields";
import { type RequestData, successResult } from "./responses";
import { type TagEntry } from "./tags";

export async function handleCopyItem(data: RequestData) {
  let itemKey = requireNonEmptyString(data.item_key, "item_key");
  let original = await getUserItemOrThrow(itemKey);
  let newItem = original.clone(original.libraryID, {
    includeCollections: true,
  });
  if (newItem.isRegularItem()) {
    let currentTitle = newItem.getField("title");
    if (currentTitle) {
      newItem.setField("title", currentTitle + " (copy)");
    }
  }
  // saveTx() returns number | boolean in zotero-types; for a new item it is always the numeric ID
  let newItemID = (await newItem.saveTx()) as number;
  let newItemKey = newItem.key;
  let copiedNotes = 0;
  let copiedAttachments = 0;

  if (original.isAttachment()) {
    await copyStoredAttachmentFiles(original, newItem);
  }

  if (original.isRegularItem()) {
    let noteIDs = original.getNotes(true);
    for (let note of Zotero.Items.get(noteIDs)) {
      let newNote = note.clone(original.libraryID);
      newNote.parentID = newItemID;
      await newNote.saveTx();
      copiedNotes++;
    }

    let attachmentIDs = original.getAttachments(true);
    for (let attachment of Zotero.Items.get(attachmentIDs)) {
      await cloneChildAttachmentToParent(attachment, newItemID);
      copiedAttachments++;
    }
  }

  return successResult(
    "copy_item",
    {
      item_key: itemKey,
      copied_note_count: copiedNotes,
      copied_attachment_count: copiedAttachments,
    },
    {
      new_key: newItemKey,
      new_item_key: newItemKey,
    },
  );
}

// Adds the source's tags that the target lacks; answers how many were added.
function mergeTags(sourceItem: Zotero.Item, targetItem: Zotero.Item): number {
  let targetTags = targetItem.getTags() as TagEntry[];
  let targetTagNames = new Set(targetTags.map((tag) => tag.tag));
  let added = (sourceItem.getTags() as TagEntry[]).filter((tag) => !targetTagNames.has(tag.tag));
  targetItem.setTags([...targetTags, ...added]);
  return added.length;
}

// Adds the source's relation values that the target lacks; answers how many were added.
function mergeRelations(sourceItem: Zotero.Item, targetItem: Zotero.Item): number {
  let added = 0;
  let targetRelations = targetItem.getRelations();
  for (let [predicate, sourceValues] of Object.entries(sourceItem.getRelations())) {
    let key = predicate as _ZoteroTypes.RelationsPredicate;
    // getRelations() omits predicates the item has no values for, but zotero-types
    // models the result as a total Record; read the real runtime type before copying.
    let existingValues: string[] | undefined = targetRelations[key];
    let targetValues = existingValues === undefined ? [] : existingValues;
    let newValues = [...new Set(sourceValues)].filter((value) => !targetValues.includes(value));
    added += newValues.length;
    targetRelations = { ...targetRelations, [key]: [...targetValues, ...newValues] };
  }
  targetItem.setRelations(targetRelations);
  return added;
}

// Moves the child items to the new parent; answers how many were moved.
async function reparent(childIDs: number[], parent: Zotero.Item): Promise<number> {
  let children = Zotero.Items.get(childIDs);
  for (let child of children) {
    child.parentID = parent.id;
    await child.saveTx();
  }
  return children.length;
}

export async function handleMergeItems(data: RequestData) {
  let sourceKey = requireNonEmptyString(data.source_key, "source_key");
  let targetKey = requireNonEmptyString(data.target_key, "target_key");
  if (sourceKey === targetKey) {
    throw conflict("Source and target items must be different");
  }

  let sourceItem = await getUserItemOrThrow(sourceKey);
  let targetItem = await getUserItemOrThrow(targetKey);
  if (!sourceItem.isRegularItem() || !targetItem.isRegularItem()) {
    throw conflict("merge_items requires two regular Zotero items");
  }
  let tags = mergeTags(sourceItem, targetItem);
  let relations = mergeRelations(sourceItem, targetItem);
  await targetItem.saveTx();

  let notes = await reparent(sourceItem.getNotes(true), targetItem);
  let attachments = await reparent(sourceItem.getAttachments(true), targetItem);
  let transferred = { attachments, notes, tags, relations };

  sourceItem.deleted = true;
  await sourceItem.saveTx();

  return successResult("merge_items", {
    source_key: sourceKey,
    target_key: targetKey,
    transferred: transferred,
  });
}
