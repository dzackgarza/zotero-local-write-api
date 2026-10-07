import { badRequest, conflict } from "./errors";
import {
  citationKey,
  getUserCollectionOrThrow,
  getUserItemOrThrow,
  userLibraryID,
} from "./library";
import {
  normalizeStringList,
  optionalNonEmptyString,
  requireNonEmptyString,
  requireObject,
  requireString,
} from "./request-fields";
import { type JsonPayload, type RequestData, successResult } from "./responses";

export async function handleUpdateItemFields(data: RequestData) {
  let itemKey = requireNonEmptyString(data.item_key, "item_key");
  let fields = requireObject(data.fields, "fields");
  let item = await getUserItemOrThrow(itemKey);
  let json = item.toJSON();
  let merged = { ...json, ...fields };
  item.fromJSON(merged);
  await item.saveTx();
  return successResult("update_item_fields", {
    item_key: itemKey,
    field_names: Object.keys(fields).sort(),
  });
}

export async function handleReplaceItemJSON(data: RequestData) {
  let itemKey = requireNonEmptyString(data.item_key, "item_key");
  let itemJSON = requireObject(data.item_json, "item_json");
  let item = await getUserItemOrThrow(itemKey);
  item.fromJSON(itemJSON);
  await item.saveTx();
  return successResult("replace_item_json", {
    item_key: itemKey,
    item_type: item.itemType,
  });
}

export async function handleAttachNote(data: RequestData) {
  let parentItemKey = requireNonEmptyString(data.parent_item_key, "parent_item_key");
  let noteText = requireString(data.note_text, "note_text");
  let parentItem = await getUserItemOrThrow(parentItemKey);

  let noteItem = new Zotero.Item("note");
  noteItem.libraryID = parentItem.libraryID;
  noteItem.parentID = parentItem.id;
  noteItem.setNote(noteText);
  await noteItem.saveTx();

  return successResult(
    "attach_note",
    {
      parent_item_key: parentItemKey,
      note_length: noteText.length,
      title: typeof data.title === "string" ? data.title : null,
    },
    {
      note_key: noteItem.key,
      note_id: noteItem.id,
    },
  );
}

export async function handleUpdateNote(data: RequestData) {
  let noteKey = requireNonEmptyString(data.note_key, "note_key");
  let newContent = requireString(data.new_content, "new_content");
  let noteItem = await getUserItemOrThrow(noteKey);
  if (!noteItem.isNote()) {
    throw conflict("Item is not a note: " + noteKey);
  }
  noteItem.setNote(newContent);
  await noteItem.saveTx();

  return successResult("update_note", {
    note_key: noteKey,
    // parentKey is `false`/undefined for a top-level note with no parent item;
    // optionalNonEmptyString maps every non-key value to null.
    parent_item_key: optionalNonEmptyString(noteItem.parentKey),
    content_length: newContent.length,
  });
}

export async function handleAttachURL(data: RequestData) {
  let parentItemKey = requireNonEmptyString(data.parent_item_key, "parent_item_key");
  let url = requireNonEmptyString(data.url, "url");
  let parentItem = await getUserItemOrThrow(parentItemKey);
  let title = typeof data.title === "string" && data.title.trim() ? data.title.trim() : null;

  let attachment = await Zotero.Attachments.linkFromURL({
    url: url,
    parentItemID: parentItem.id,
    title: title,
  });

  return successResult(
    "attach_url",
    {
      parent_item_key: parentItemKey,
      url: url,
      // Report the requested title, or the title Zotero auto-assigned when none was given.
      title: title === null ? attachment.getField("title") : title,
    },
    {
      attachment_key: attachment.key,
      attachment_id: attachment.id,
    },
  );
}

export async function handleTrashItem(data: RequestData) {
  let itemKey = requireNonEmptyString(data.item_key, "item_key");
  let item = await getUserItemOrThrow(itemKey);
  item.deleted = true;
  await item.saveTx();
  return successResult("trash_item", {
    item_key: itemKey,
    item_type: item.itemType,
  });
}

export async function handleRelinkAttachmentFile(data: RequestData) {
  let attachmentKey = requireNonEmptyString(data.attachment_key, "attachment_key");
  let filePath = requireNonEmptyString(data.file_path, "file_path");
  let attachment = await getUserItemOrThrow(attachmentKey);
  if (!attachment.isAttachment()) {
    throw conflict("Item is not an attachment: " + attachmentKey);
  }
  await attachment.relinkAttachmentFile(filePath);
  return successResult("relink_attachment_file", {
    attachment_key: attachmentKey,
    file_path: filePath,
  });
}

// A syntactically fine string is not necessarily a Zotero item type. Without
// this, an unknown type reaches Zotero and surfaces as an unclassified 500
// ("Invalid item type id 'false'") rather than a 400 naming the bad input.
function requireItemType(itemType: string): string {
  let itemTypeID = Zotero.ItemTypes.getID(itemType);
  if (itemTypeID === false || itemTypeID === 0) {
    throw badRequest("Invalid item_type: " + itemType);
  }
  return itemType;
}

// The item a create_item request describes: its type, field values, tags and collections.
type NewItem = {
  itemType: string;
  fields: JsonPayload;
  tags: string[];
  collectionKeys: string[];
};

// Saves the new item in the user library; every named collection must exist first.
// itemType is a user-supplied item-type name; Zotero validates it at runtime and
// throws on an unknown type. The constructor types the name as a literal union, so
// narrow the runtime string to that union (a no-op at runtime).
async function saveNewItem(newItem: NewItem): Promise<Zotero.Item> {
  for (let collectionKey of newItem.collectionKeys) {
    await getUserCollectionOrThrow(collectionKey);
  }
  let item = new Zotero.Item(
    newItem.itemType as _ZoteroTypes.Item.ItemTypeMapping[keyof _ZoteroTypes.Item.ItemTypeMapping],
  );
  item.libraryID = userLibraryID();
  item.fromJSON({ ...item.toJSON(), ...newItem.fields });
  if (newItem.tags.length) {
    item.setTags(newItem.tags);
  }
  if (newItem.collectionKeys.length) {
    item.setCollections(newItem.collectionKeys);
  }
  await item.saveTx();
  return item;
}

// The create_item response details: what the request asked the new item to carry.
function newItemDetails(newItem: NewItem): JsonPayload {
  return {
    item_type: newItem.itemType,
    field_names: Object.keys(newItem.fields).sort(),
    tag_count: newItem.tags.length,
    collection_count: newItem.collectionKeys.length,
  };
}

export async function handleCreateItem(data: RequestData) {
  let newItem: NewItem = {
    itemType: requireItemType(requireNonEmptyString(data.item_type, "item_type")),
    fields: Boolean(data.fields) ? requireObject(data.fields, "fields") : {},
    tags: Boolean(data.tags) ? normalizeStringList(data.tags, "tags") : [],
    collectionKeys: Boolean(data.collection_keys)
      ? normalizeStringList(data.collection_keys, "collection_keys")
      : [],
  };
  let item = await saveNewItem(newItem);
  return successResult("create_item", newItemDetails(newItem), {
    item_key: item.key,
    item_id: item.id,
    citation_key: await citationKey(item),
  });
}

export async function handleRestoreItem(data: RequestData) {
  let itemKey = requireNonEmptyString(data.item_key, "item_key");
  let item = await getUserItemOrThrow(itemKey);
  item.deleted = false;
  await item.saveTx();
  return successResult("restore_item", {
    item_key: itemKey,
    item_type: item.itemType,
  });
}

export async function handleUpdateAttachmentTitle(data: RequestData) {
  let attachmentKey = requireNonEmptyString(data.attachment_key, "attachment_key");
  let newTitle = requireNonEmptyString(data.new_title, "new_title");
  let attachment = await getUserItemOrThrow(attachmentKey);
  if (!attachment.isAttachment()) {
    throw conflict("Item is not an attachment: " + attachmentKey);
  }
  attachment.setField("title", newTitle);
  await attachment.saveTx();
  return successResult("update_attachment_title", {
    attachment_key: attachmentKey,
    new_title: newTitle,
  });
}
