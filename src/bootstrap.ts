// APP_SHUTDOWN is a Zotero bootstrap constant not in zotero-types
declare let APP_SHUTDOWN: number;

// Single source of truth for the places where zotero-types under-models fields that
// Zotero accepts at runtime. Each helper owns exactly one runtime-contract widening so
// the rest of the file reads cleanly typed instead of scattering casts.

// Zotero accepts `false` for Collection.parentKey to detach a collection from its
// parent, but zotero-types models the field as `string`. This is the single owned site
// that writes that runtime contract; callers go through it instead of casting.
function setCollectionParentKey(collection: Zotero.Collection, parentKey: string | false): void {
  (collection as { parentKey: string | false }).parentKey = parentKey;
}

// Tags.js guards `if (onProgress)` and `if (types)`, so both are optional at runtime;
// zotero-types incorrectly marks them required. This is the single owned site that calls
// removeFromLibrary against its real two-argument contract.
function removeTagsFromUserLibrary(libraryID: number, tagIDs: number[]): Promise<void> {
  let remove = Zotero.Tags.removeFromLibrary as (
    libraryID: number,
    tagIDs: number[],
  ) => Promise<void>;
  return remove(libraryID, tagIDs);
}

// A Zotero HTTP endpoint is registered as a constructor function whose prototype carries
// the request metadata and init handler. The slot is cleared to undefined on shutdown.
type EndpointPrototype = {
  supportedMethods: string[];
  supportedDataTypes?: string[];
  init: (...args: never[]) => void | Promise<void>;
};
type EndpointConstructor = { (): void; prototype: EndpointPrototype };

let AttachEndpoint: EndpointConstructor | undefined;
let WriteEndpoint: EndpointConstructor | undefined;
let VersionEndpoint: EndpointConstructor | undefined;

let PLUGIN_VERSION = "3.2.0-dev";
let FULLTEXT_ATTACH_PATH = "/attach";
let LOCAL_WRITE_PATH = "/write";
let VERSION_PATH = "/version";
let FULLTEXT_ALLOWED_DIRS = ["/tmp", "/var/tmp"];
let ADDON_ID = "local-write-api@dzackgarza.com";
let HOMEPAGE_URL = "https://github.com/dzackgarza/zotero-local-write-api";
let UPDATE_URL =
  "https://raw.githubusercontent.com/dzackgarza/zotero-local-write-api/main/updates.json";
let STRICT_MIN_VERSION = "7.0";
let STRICT_MAX_VERSION = "*";
let TESTED_ZOTERO_VERSION = "8.0.1";
let PLUGIN_CAPABILITIES = [
  "attach",
  "attach_bytes",
  "write",
  "version_probe",
  "health_probe",
  "import_bibtex",
  "import_by_identifier",
  "selected_collection",
  "sync",
  "run_javascript",
];

let BIBTEX_TRANSLATOR_ID = "9cb70025-a888-4a29-a210-93ec52da40d4";

type RequestData = Record<string, unknown>;
type SendResponse = (status: number, contentType: string, body: string) => void;
type JsonPayload = Record<string, unknown>;
type TagEntry = { tag: string; type: number };
type Identifier = Record<string, string>;
type ImportTranslator = {
  setTranslator(translatorId: string): void;
  setString(input: string): void;
  translate(options: {
    libraryID: number;
    collections: number[];
    saveAttachments: boolean;
  }): Promise<unknown>;
};
type ActiveZoteroPane = {
  getSelectedCollection(): Zotero.Collection | null;
};

function log(msg: string): void {
  Zotero.debug("Local Write API: " + msg);
}

function sendJSON(sendResponse: SendResponse, statusCode: number, payload: JsonPayload): void {
  sendResponse(statusCode, "application/json", JSON.stringify(payload));
}

function successResult(operation: string, details?: JsonPayload, extra?: JsonPayload): JsonPayload {
  let payload: JsonPayload = {
    success: true,
    operation: operation,
    stage: "completed",
    version: PLUGIN_VERSION,
  };
  if (details) {
    payload.details = details;
  }
  if (extra) {
    Object.assign(payload, extra);
  }
  return payload;
}

function errorResult(
  operation: string,
  stage: string,
  error: string,
  details: JsonPayload,
): JsonPayload {
  return {
    success: false,
    operation: operation,
    stage: stage,
    error: error,
    details: details,
    version: PLUGIN_VERSION,
  };
}

function pluginVersionPayload(): JsonPayload {
  return {
    success: true,
    healthy: true,
    status: "ok",
    message: "Local Write API is running.",
    version: PLUGIN_VERSION,
    addon_id: ADDON_ID,
    homepage_url: HOMEPAGE_URL,
    update_url: UPDATE_URL,
    endpoints: {
      attach: FULLTEXT_ATTACH_PATH,
      write: LOCAL_WRITE_PATH,
      version: VERSION_PATH,
    },
    compatibility: {
      strict_min_version: STRICT_MIN_VERSION,
      strict_max_version: STRICT_MAX_VERSION,
      tested_zotero_version: TESTED_ZOTERO_VERSION,
    },
    capabilities: PLUGIN_CAPABILITIES.slice(),
  };
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(fieldName + " must be a string");
  }
  return value;
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
  let cleaned = requireString(value, fieldName).trim();
  if (!cleaned) {
    throw new Error(fieldName + " must be a non-empty string");
  }
  return cleaned;
}

function optionalNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  let cleaned = value.trim();
  return cleaned ? cleaned : null;
}

function requireObject(value: unknown, fieldName: string): JsonPayload {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(fieldName + " must be an object");
  }
  return value as JsonPayload;
}

function normalizeStringList(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(fieldName + " must be an array of strings");
  }
  let normalized: string[] = [];
  let seen = new Set<string>();
  for (let entry of value) {
    if (typeof entry !== "string") {
      throw new Error(fieldName + " entries must be strings");
    }
    let cleaned = entry.trim();
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }
    normalized.push(cleaned);
    seen.add(cleaned);
  }
  return normalized;
}

function userLibraryID(): number {
  return Zotero.Libraries.userLibraryID;
}

async function getUserItemOrThrow(itemKey: string) {
  let item = await Zotero.Items.getByLibraryAndKey(userLibraryID(), itemKey);
  if (!item) {
    throw new Error("Item not found: " + itemKey);
  }
  return item;
}

async function getUserCollectionOrThrow(collectionKey: string) {
  let collection = await Zotero.Collections.getByLibraryAndKey(userLibraryID(), collectionKey);
  if (!collection) {
    throw new Error("Collection not found: " + collectionKey);
  }
  return collection;
}

function collectionDetails(collection: Zotero.Collection): JsonPayload {
  // parentKey is the documented `false` sentinel when the collection has no parent;
  // zotero-types models only the `string` case, so read through the real runtime type.
  let parentKey = (collection as { parentKey: string | false }).parentKey;
  return {
    collection_key: collection.key,
    collection_name: collection.name,
    parent_key: parentKey === false ? null : parentKey,
  };
}

async function copyStoredAttachmentFiles(
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

async function cloneChildAttachmentToParent(
  sourceAttachment: Zotero.Item,
  parentItemID: number,
): Promise<Zotero.Item> {
  let newAttachment = sourceAttachment.clone(sourceAttachment.libraryID);
  newAttachment.parentID = parentItemID;
  await newAttachment.saveTx();
  await copyStoredAttachmentFiles(sourceAttachment, newAttachment);
  return newAttachment;
}

function resolveAttachFilePath(filePath: string): string {
  let file = Zotero.File.pathToFile(filePath);
  if (!file.exists()) {
    throw new Error("File not found: " + filePath);
  }
  return file.path;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof (error as Error).message === "string" &&
    (error as Error).message.includes("NS_ERROR_FILE_NOT_FOUND")
  );
}

async function materializeUploadBytes(fileName: string, fileBytesBase64: string) {
  let tempDir = Zotero.getTempDirectory();
  let safeFileName = Zotero.File.getValidFileName(fileName.trim());
  if (!safeFileName) {
    throw new Error("File name has no valid characters: " + fileName);
  }
  tempDir.append(
    `local-write-api-${Date.now()}-${Math.random().toString(16).slice(2)}-${safeFileName}`,
  );
  let binary = atob(fileBytesBase64);
  let bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  // Zotero.File.putContentsAsync() accepts Blob at runtime, but zotero-types
  // only advertises string | ArrayBuffer | nsIInputStream.
  await Zotero.File.putContentsAsync(tempDir.path, new Blob([bytes]) as unknown as ArrayBuffer);
  return tempDir.path;
}

async function importStoredAttachment(
  parentItem: Zotero.Item,
  filePath: string,
  title: string,
): Promise<Zotero.Item> {
  let resolvedFilePath = resolveAttachFilePath(filePath);
  // Copy the file into Zotero's own temp directory before importing.
  // Passing a /tmp path directly causes NS_ERROR_FILE_NOT_FOUND from
  // nsIFile.copyToFollowingLinks when the path resolves through a symlink
  // that Zotero's process cannot follow (observed on Linux tmpfs mounts).
  let sourceFile = Zotero.File.pathToFile(resolvedFilePath);
  let tempDir = Zotero.getTempDirectory();
  let tempName = `local-write-api-${Date.now()}-${sourceFile.leafName}`;
  sourceFile.copyTo(tempDir, tempName);
  let tempFile = tempDir.clone();
  tempFile.append(tempName);
  let attachment: Zotero.Item;
  try {
    let result = await Zotero.Attachments.importFromFile({
      file: tempFile.path,
      libraryID: parentItem.libraryID,
      parentItemID: parentItem.id,
      title: title,
    });
    if (!result) {
      throw new Error("Failed to create attachment");
    }
    await result.saveTx();
    attachment = result;
  } finally {
    if (tempFile.exists()) {
      tempFile.remove(false);
    }
  }
  return attachment;
}

async function handleFulltextAttach(data: RequestData) {
  let itemKey = requireNonEmptyString(data.item_key, "item_key");
  let title = requireNonEmptyString(data.title, "title");
  let filePath = optionalNonEmptyString(data.file_path);
  let fileName = optionalNonEmptyString(data.file_name);
  let fileBytesBase64 = optionalNonEmptyString(data.file_bytes_base64);

  if (!filePath && !fileBytesBase64) {
    throw new Error("Either file_path or file_bytes_base64 must be provided");
  }

  let parentItem = await getUserItemOrThrow(itemKey);
  let attachment: Zotero.Item;
  let sourceMode = "path";
  let tempPath: string | null = null;

  try {
    if (filePath) {
      if (!FULLTEXT_ALLOWED_DIRS.some((dir) => filePath.startsWith(dir))) {
        throw new Error(
          "File path must be within allowed directories: " + FULLTEXT_ALLOWED_DIRS.join(", "),
        );
      }
      try {
        attachment = await importStoredAttachment(parentItem, filePath, title);
      } catch (error) {
        if (!fileBytesBase64 || !isMissingFileError(error)) {
          throw error;
        }
        let fallbackName = fileName ? fileName : Zotero.File.pathToFile(filePath).leafName;
        tempPath = await materializeUploadBytes(fallbackName, fileBytesBase64);
        attachment = await importStoredAttachment(parentItem, tempPath, title);
        sourceMode = "bytes_fallback";
      }
    } else {
      let requiredFileName = requireNonEmptyString(data.file_name, "file_name");
      tempPath = await materializeUploadBytes(
        requiredFileName,
        requireNonEmptyString(data.file_bytes_base64, "file_bytes_base64"),
      );
      attachment = await importStoredAttachment(parentItem, tempPath, title);
      sourceMode = "bytes";
    }
  } finally {
    if (tempPath) {
      try {
        Zotero.File.pathToFile(tempPath).remove(false);
      } catch (error) {
        Zotero.logError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  return successResult(
    "attach_file_to_item",
    {
      parent_item_key: itemKey,
      file_path: filePath,
      source_mode: sourceMode,
      title: title,
    },
    {
      attachment_key: attachment.key,
      attachment_id: attachment.id,
      message: "File attached successfully to item " + itemKey,
      handler: "fulltext-attach",
    },
  );
}

async function handleUpdateItemFields(data: RequestData) {
  let itemKey = requireNonEmptyString(data.item_key, "item_key");
  let fields = requireObject(data.fields, "fields");
  let item = await getUserItemOrThrow(itemKey);
  let json = item.toJSON();
  Object.assign(json, fields);
  item.fromJSON(json);
  await item.saveTx();
  return successResult("update_item_fields", {
    item_key: itemKey,
    field_names: Object.keys(fields).sort(),
  });
}

async function handleReplaceItemJSON(data: RequestData) {
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

async function handleSetItemTags(data: RequestData) {
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

async function handleSetItemCollections(data: RequestData) {
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

async function handleAttachNote(data: RequestData) {
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

async function handleUpdateNote(data: RequestData) {
  let noteKey = requireNonEmptyString(data.note_key, "note_key");
  let newContent = requireString(data.new_content, "new_content");
  let noteItem = await getUserItemOrThrow(noteKey);
  if (!noteItem.isNote()) {
    throw new Error("Item is not a note: " + noteKey);
  }
  noteItem.setNote(newContent);
  await noteItem.saveTx();

  return successResult("update_note", {
    note_key: noteKey,
    // parentKey is `false`/undefined for a top-level note with no parent item.
    parent_item_key: noteItem.parentKey ? noteItem.parentKey : null,
    content_length: newContent.length,
  });
}

async function handleAttachURL(data: RequestData) {
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

async function handleTrashItem(data: RequestData) {
  let itemKey = requireNonEmptyString(data.item_key, "item_key");
  let item = await getUserItemOrThrow(itemKey);
  item.deleted = true;
  await item.saveTx();
  return successResult("trash_item", {
    item_key: itemKey,
    item_type: item.itemType,
  });
}

async function handleTrashCollection(data: RequestData) {
  let collectionKey = requireNonEmptyString(data.collection_key, "collection_key");
  let collection = await getUserCollectionOrThrow(collectionKey);
  collection.deleted = true;
  await collection.saveTx();
  return successResult("trash_collection", collectionDetails(collection));
}

async function handleRelinkAttachmentFile(data: RequestData) {
  let attachmentKey = requireNonEmptyString(data.attachment_key, "attachment_key");
  let filePath = requireNonEmptyString(data.file_path, "file_path");
  let attachment = await getUserItemOrThrow(attachmentKey);
  if (!attachment.isAttachment()) {
    throw new Error("Item is not an attachment: " + attachmentKey);
  }
  await attachment.relinkAttachmentFile(filePath);
  return successResult("relink_attachment_file", {
    attachment_key: attachmentKey,
    file_path: filePath,
  });
}

async function handleCreateCollection(data: RequestData) {
  let name = requireNonEmptyString(data.name, "name");
  let parentKey: string | null = null;
  if (typeof data.parent_key === "string" && data.parent_key.trim()) {
    parentKey = data.parent_key.trim();
    await getUserCollectionOrThrow(parentKey);
  }

  let collection = new Zotero.Collection({ libraryID: userLibraryID(), name });
  if (parentKey) {
    collection.parentKey = parentKey;
  }
  await collection.saveTx();

  return successResult("create_collection", collectionDetails(collection));
}

async function handleRenameCollection(data: RequestData) {
  let collectionKey = requireNonEmptyString(data.collection_key, "collection_key");
  let newName = requireNonEmptyString(data.new_name, "new_name");
  let collection = await getUserCollectionOrThrow(collectionKey);
  collection.name = newName;
  await collection.saveTx();

  return successResult("rename_collection", collectionDetails(collection));
}

async function handleMoveCollection(data: RequestData) {
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

async function handleMergeCollections(data: RequestData) {
  let sourceKeys = normalizeStringList(data.source_keys, "source_keys");
  let targetKey = requireNonEmptyString(data.target_key, "target_key");
  if (sourceKeys.includes(targetKey)) {
    throw new Error("Target collection cannot also be a source collection");
  }
  let targetCollection = await getUserCollectionOrThrow(targetKey);
  let movedItems = 0;
  let movedChildren = 0;
  let trashedSources = 0;

  for (let sourceKey of sourceKeys) {
    let sourceCollection = await getUserCollectionOrThrow(sourceKey);
    let descendents = sourceCollection.getDescendents(false, null, false);
    if (descendents.some((d) => d.type === "collection" && d.key === targetKey)) {
      throw new Error("Cannot merge a collection into one of its descendants");
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

async function handleRenameTag(data: RequestData) {
  let oldName = requireNonEmptyString(data.old_name, "old_name");
  let newName = requireNonEmptyString(data.new_name, "new_name");
  await Zotero.Tags.rename(userLibraryID(), oldName, newName);
  return successResult("rename_tag", {
    old_name: oldName,
    new_name: newName,
  });
}

async function handleMergeTags(data: RequestData) {
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

async function handleDeleteTag(data: RequestData) {
  let tagName = requireNonEmptyString(data.tag_name, "tag_name");
  let tagID = Zotero.Tags.getID(tagName);
  if (!tagID) {
    throw new Error("Tag not found: " + tagName);
  }

  // Remove the tag from every item that carries it before removing it from the
  // library, and report how many items changed.
  let search = new Zotero.Search({ libraryID: userLibraryID() });
  search.addCondition("tag", "is", tagName);
  let itemIDs = await search.search();

  let modifiedCount = 0;
  if (itemIDs && itemIDs.length > 0) {
    let items = await Zotero.Items.getAsync(itemIDs);
    for (let item of items) {
      if (item.removeTag(tagName)) {
        await item.saveTx();
        modifiedCount++;
      }
    }
  }

  await removeTagsFromUserLibrary(userLibraryID(), [tagID]);

  return successResult("delete_tag", {
    tag_name: tagName,
    modified_item_count: modifiedCount,
  });
}

async function handleDeleteUnusedTags(_data: RequestData) {
  Zotero.Prefs.set("purge.tags", true);
  await Zotero.DB.executeTransaction(async function () {
    await Zotero.Tags.purge();
  });
  return successResult("delete_unused_tags", {});
}

async function handleCopyItem(data: RequestData) {
  let itemKey = requireNonEmptyString(data.item_key, "item_key");
  let original = await getUserItemOrThrow(itemKey);
  let newItem = original.clone(original.libraryID, { includeCollections: true });
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

async function handleMergeItems(data: RequestData) {
  let sourceKey = requireNonEmptyString(data.source_key, "source_key");
  let targetKey = requireNonEmptyString(data.target_key, "target_key");
  if (sourceKey === targetKey) {
    throw new Error("Source and target items must be different");
  }

  let sourceItem = await getUserItemOrThrow(sourceKey);
  let targetItem = await getUserItemOrThrow(targetKey);
  if (!sourceItem.isRegularItem() || !targetItem.isRegularItem()) {
    throw new Error("merge_items requires two regular Zotero items");
  }
  let transferred = {
    attachments: 0,
    notes: 0,
    tags: 0,
    relations: 0,
  };

  let sourceTags = sourceItem.getTags() as TagEntry[];
  let targetTags = targetItem.getTags() as TagEntry[];
  let targetTagNames = new Set(targetTags.map((tag) => tag.tag));
  for (let tag of sourceTags) {
    if (!targetTagNames.has(tag.tag)) {
      targetTags.push(tag);
      targetTagNames.add(tag.tag);
      transferred.tags++;
    }
  }
  targetItem.setTags(targetTags);

  let sourceRelations = sourceItem.getRelations();
  let targetRelations = targetItem.getRelations();
  for (let [predicate, sourceValues] of Object.entries(sourceRelations)) {
    let key = predicate as _ZoteroTypes.RelationsPredicate;
    let targetValues = targetRelations[key] ? [...targetRelations[key]] : [];
    let targetValueSet = new Set(targetValues);
    for (let value of sourceValues) {
      if (!targetValueSet.has(value)) {
        targetValues.push(value);
        targetValueSet.add(value);
        transferred.relations++;
      }
    }
    targetItem.setRelations({ ...targetRelations, [key]: targetValues });
    targetRelations = targetItem.getRelations();
  }
  await targetItem.saveTx();

  for (let note of Zotero.Items.get(sourceItem.getNotes(true))) {
    note.parentID = targetItem.id;
    await note.saveTx();
    transferred.notes++;
  }
  for (let attachment of Zotero.Items.get(sourceItem.getAttachments(true))) {
    attachment.parentID = targetItem.id;
    await attachment.saveTx();
    transferred.attachments++;
  }

  sourceItem.deleted = true;
  await sourceItem.saveTx();

  return successResult("merge_items", {
    source_key: sourceKey,
    target_key: targetKey,
    transferred: transferred,
  });
}

async function handleCreateItem(data: RequestData) {
  let itemType = requireNonEmptyString(data.item_type, "item_type");
  let fields = data.fields ? requireObject(data.fields, "fields") : {};
  let tags = data.tags ? normalizeStringList(data.tags, "tags") : [];
  let collectionKeys = data.collection_keys
    ? normalizeStringList(data.collection_keys, "collection_keys")
    : [];

  for (let collectionKey of collectionKeys) {
    await getUserCollectionOrThrow(collectionKey);
  }

  // itemType is a user-supplied item-type name; Zotero validates it at runtime and
  // throws on an unknown type. The constructor types the name as a literal union, so
  // narrow the runtime string to that union (a no-op at runtime).
  let item = new Zotero.Item(
    itemType as _ZoteroTypes.Item.ItemTypeMapping[keyof _ZoteroTypes.Item.ItemTypeMapping],
  );
  item.libraryID = userLibraryID();

  let json = item.toJSON();
  Object.assign(json, fields);
  item.fromJSON(json);

  if (tags.length) {
    item.setTags(tags);
  }
  if (collectionKeys.length) {
    item.setCollections(collectionKeys);
  }

  await item.saveTx();

  return successResult(
    "create_item",
    {
      item_type: itemType,
      field_names: Object.keys(fields).sort(),
      tag_count: tags.length,
      collection_count: collectionKeys.length,
    },
    {
      item_key: item.key,
      item_id: item.id,
    },
  );
}

async function handleAddItemTags(data: RequestData) {
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

async function handleRemoveItemTags(data: RequestData) {
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

async function handleAddItemToCollection(data: RequestData) {
  let itemKey = requireNonEmptyString(data.item_key, "item_key");
  let collectionKey = requireNonEmptyString(data.collection_key, "collection_key");
  let item = await getUserItemOrThrow(itemKey);
  let collection = await getUserCollectionOrThrow(collectionKey);
  let currentKeys = item.getCollections().map((id) => Zotero.Collections.get(id).key);
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

async function handleRemoveItemFromCollection(data: RequestData) {
  let itemKey = requireNonEmptyString(data.item_key, "item_key");
  let collectionKey = requireNonEmptyString(data.collection_key, "collection_key");
  let item = await getUserItemOrThrow(itemKey);
  let collection = await getUserCollectionOrThrow(collectionKey);
  let currentKeys = item
    .getCollections()
    .map((id) => Zotero.Collections.get(id).key)
    .filter((k) => k !== collectionKey);
  item.setCollections(currentKeys);
  await item.saveTx();
  return successResult("remove_item_from_collection", {
    item_key: itemKey,
    collection_key: collectionKey,
    collection_name: collection.name,
  });
}

function extractIdentifiers(raw: string): Identifier[] {
  let utilities = Zotero.Utilities as typeof Zotero.Utilities & {
    extractIdentifiers(identifier: string): Identifier[];
  };
  let identifiers = utilities.extractIdentifiers(raw);
  if (!identifiers.length) {
    throw new Error("Could not parse identifier");
  }
  return identifiers;
}

function createImportTranslator(): ImportTranslator {
  let translateApi = Zotero.Translate as {
    Import: new () => ImportTranslator;
  };
  return new translateApi.Import();
}

function requireImportedItems(value: unknown, operation: string): Zotero.Item[] {
  if (!Array.isArray(value)) {
    throw new Error(operation + " did not return an item array");
  }
  for (let item of value) {
    if (typeof item !== "object" || item === null) {
      throw new Error(operation + " returned a non-object item");
    }
    let candidate = item as { key?: unknown; id?: unknown };
    if (typeof candidate.key !== "string" || typeof candidate.id !== "number") {
      throw new Error(operation + " returned an item without key/id");
    }
  }
  return value as Zotero.Item[];
}

async function handleImportBibTeX(data: RequestData) {
  let bibtex = requireNonEmptyString(data.bibtex, "bibtex");
  let collectionKeys = data.collection_keys
    ? normalizeStringList(data.collection_keys, "collection_keys")
    : [];
  let collectionIDs: number[] = [];
  for (let collectionKey of collectionKeys) {
    let collection = await getUserCollectionOrThrow(collectionKey);
    collectionIDs.push(collection.id);
  }

  let translator = createImportTranslator();
  translator.setTranslator(BIBTEX_TRANSLATOR_ID);
  translator.setString(bibtex);
  let items = requireImportedItems(
    await translator.translate({
      libraryID: userLibraryID(),
      collections: collectionIDs,
      saveAttachments: true,
    }),
    "import_bibtex",
  );
  if (items.length !== 1) {
    throw new Error("import_bibtex must create exactly one Zotero item");
  }

  return successResult(
    "import_bibtex",
    {
      item_count: items.length,
      collection_keys: collectionKeys,
      translator_id: BIBTEX_TRANSLATOR_ID,
    },
    {
      item_key: items[0].key,
      item_id: items[0].id,
      item_keys: items.map((item) => item.key),
      item_ids: items.map((item) => item.id),
      titles: items.map((item) => item.getField("title")),
    },
  );
}

async function translateIdentifier(
  identifier: Identifier,
  collections: number[] | false,
): Promise<Zotero.Item[]> {
  let search = new Zotero.Translate.Search();
  search.setIdentifier(identifier);
  let translators = await search.getTranslators();
  if (!translators || translators.length === 0) {
    throw new Error("No translator available for identifier: " + JSON.stringify(identifier));
  }
  search.setTranslator(translators);
  let items = await search.translate({
    libraryID: userLibraryID(),
    collections: collections,
    saveAttachments: true,
  });
  if (!items || items.length === 0) {
    throw new Error("No item found for identifier: " + JSON.stringify(identifier));
  }
  return items;
}

async function handleImportByIdentifier(data: RequestData) {
  let raw = requireNonEmptyString(data.identifier, "identifier");
  let collectionKeys = data.collection_keys
    ? normalizeStringList(data.collection_keys, "collection_keys")
    : [];
  let collections: number[] = [];
  for (let collectionKey of collectionKeys) {
    let collection = await getUserCollectionOrThrow(collectionKey);
    collections.push(collection.id);
  }

  let items: Zotero.Item[] = [];
  for (let identifier of extractIdentifiers(raw)) {
    items.push(...(await translateIdentifier(identifier, collections)));
  }

  return successResult(
    "import_by_identifier",
    {
      identifier: raw,
      item_count: items.length,
      collection_keys: collectionKeys,
    },
    {
      item_key: items[0].key,
      item_id: items[0].id,
      item_keys: items.map((item) => item.key),
      item_ids: items.map((item) => item.id),
      titles: items.map((item) => item.getField("title")),
    },
  );
}

function handleGetSelectedCollection(): JsonPayload {
  let pane = Zotero.getActiveZoteroPane() as ActiveZoteroPane;
  let collection = pane.getSelectedCollection();
  if (!collection) {
    throw new Error("No Collection selected.");
  }
  return successResult("get_selected_collection", {
    collection_key: collection.key,
    collection_name: collection.name,
  });
}

async function handleRestoreItem(data: RequestData) {
  let itemKey = requireNonEmptyString(data.item_key, "item_key");
  let item = await getUserItemOrThrow(itemKey);
  item.deleted = false;
  await item.saveTx();
  return successResult("restore_item", {
    item_key: itemKey,
    item_type: item.itemType,
  });
}

async function handleUpdateAttachmentTitle(data: RequestData) {
  let attachmentKey = requireNonEmptyString(data.attachment_key, "attachment_key");
  let newTitle = requireNonEmptyString(data.new_title, "new_title");
  let attachment = await getUserItemOrThrow(attachmentKey);
  if (!attachment.isAttachment()) {
    throw new Error("Item is not an attachment: " + attachmentKey);
  }
  attachment.setField("title", newTitle);
  await attachment.saveTx();
  return successResult("update_attachment_title", {
    attachment_key: attachmentKey,
    new_title: newTitle,
  });
}

async function handleSync(data: RequestData) {
  void data;
  let runner = Zotero.Sync && Zotero.Sync.Runner;
  if (!runner || typeof runner.sync !== "function") {
    throw new Error("Zotero.Sync.Runner.sync is unavailable");
  }
  // Foreground sync so the call resolves once the sync engine has run.
  let result = await runner.sync({ background: false });
  let serialized = JSON.parse(JSON.stringify(result));
  return successResult("sync", { triggered: true, result: serialized });
}

async function handleRunJavascript(data: RequestData) {
  // Debug endpoint: evaluate arbitrary internal JavaScript in the add-on's privileged
  // chrome scope, with `Zotero` in scope and `await` supported. Single-user dev tool.
  let code = requireNonEmptyString(data.code, "code");
  let AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (zotero: typeof Zotero) => Promise<unknown>;
  let fn = new AsyncFunction("Zotero", code);
  let result = await fn(Zotero);
  let serialized = JSON.parse(JSON.stringify(result));
  return successResult("run_javascript", { result: serialized });
}

async function runWrite(data: RequestData) {
  let operation = requireNonEmptyString(data.operation, "operation");
  switch (operation) {
    case "sync":
      return handleSync(data);
    case "run_javascript":
      return handleRunJavascript(data);
    case "update_item_fields":
      return handleUpdateItemFields(data);
    case "replace_item_json":
      return handleReplaceItemJSON(data);
    case "set_item_tags":
      return handleSetItemTags(data);
    case "add_item_tags":
      return handleAddItemTags(data);
    case "remove_item_tags":
      return handleRemoveItemTags(data);
    case "set_item_collections":
      return handleSetItemCollections(data);
    case "add_item_to_collection":
      return handleAddItemToCollection(data);
    case "remove_item_from_collection":
      return handleRemoveItemFromCollection(data);
    case "attach_note":
      return handleAttachNote(data);
    case "update_note":
      return handleUpdateNote(data);
    case "attach_url":
      return handleAttachURL(data);
    case "trash_item":
      return handleTrashItem(data);
    case "trash_collection":
      return handleTrashCollection(data);
    case "relink_attachment_file":
      return handleRelinkAttachmentFile(data);
    case "create_collection":
      return handleCreateCollection(data);
    case "rename_collection":
      return handleRenameCollection(data);
    case "move_collection":
      return handleMoveCollection(data);
    case "merge_collections":
      return handleMergeCollections(data);
    case "rename_tag":
      return handleRenameTag(data);
    case "merge_tags":
      return handleMergeTags(data);
    case "delete_tag":
      return handleDeleteTag(data);
    case "delete_unused_tags":
      return handleDeleteUnusedTags(data);
    case "copy_item":
      return handleCopyItem(data);
    case "merge_items":
      return handleMergeItems(data);
    case "create_item":
      return handleCreateItem(data);
    case "import_bibtex":
      return handleImportBibTeX(data);
    case "import_by_identifier":
      return handleImportByIdentifier(data);
    case "get_selected_collection":
      return handleGetSelectedCollection();
    case "restore_item":
      return handleRestoreItem(data);
    case "update_attachment_title":
      return handleUpdateAttachmentTitle(data);
    default:
      throw new Error("Unsupported operation: " + operation);
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function install(): void {
  log("Installed " + PLUGIN_VERSION);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function startup({
  id,
  version,
  rootURI,
}: {
  id: string;
  version: string;
  rootURI: string;
}): Promise<void> {
  void id;
  void version;
  void rootURI;
  log("Starting " + PLUGIN_VERSION);

  AttachEndpoint = function () {};
  AttachEndpoint.prototype = {
    supportedMethods: ["POST"],
    supportedDataTypes: ["application/json"],
    init: async function (data: RequestData, sendResponse: SendResponse) {
      try {
        log("Received POST request to " + FULLTEXT_ATTACH_PATH + " [v" + PLUGIN_VERSION + "]");
        sendJSON(sendResponse, 200, await handleFulltextAttach(data));
      } catch (error) {
        let msg = (error as Error).message;
        log("Error in " + FULLTEXT_ATTACH_PATH + " [v" + PLUGIN_VERSION + "]: " + msg);
        sendJSON(
          sendResponse,
          500,
          errorResult("attach_file_to_item", "attach_endpoint", msg, { request: data }),
        );
      }
    },
  };

  WriteEndpoint = function () {};
  WriteEndpoint.prototype = {
    supportedMethods: ["POST"],
    supportedDataTypes: ["application/json"],
    init: async function (data: RequestData, sendResponse: SendResponse) {
      // operation may be absent on a malformed request; label it explicitly for
      // diagnostics. This is the error-rendering boundary, not a runtime default.
      let operationLabel = typeof data.operation === "string" ? data.operation : "unknown_operation";
      try {
        log("Received POST request to " + LOCAL_WRITE_PATH + " [operation=" + operationLabel + "]");
        sendJSON(sendResponse, 200, await runWrite(data));
      } catch (error) {
        let msg = (error as Error).message;
        log("Error in " + LOCAL_WRITE_PATH + " [operation=" + operationLabel + "]: " + msg);
        sendJSON(
          sendResponse,
          500,
          errorResult(operationLabel, "write_endpoint", msg, { request: data }),
        );
      }
    },
  };

  VersionEndpoint = function () {};
  VersionEndpoint.prototype = {
    supportedMethods: ["GET"],
    init: function (_data: unknown, sendResponse: SendResponse) {
      log("Received GET request to " + VERSION_PATH + " [v" + PLUGIN_VERSION + "]");
      sendJSON(sendResponse, 200, pluginVersionPayload());
    },
  };

  Zotero.Server.Endpoints[FULLTEXT_ATTACH_PATH] = AttachEndpoint;
  Zotero.Server.Endpoints[LOCAL_WRITE_PATH] = WriteEndpoint;
  Zotero.Server.Endpoints[VERSION_PATH] = VersionEndpoint;
  log("Registered " + FULLTEXT_ATTACH_PATH + " endpoint");
  log("Registered " + LOCAL_WRITE_PATH + " endpoint");
  log("Registered " + VERSION_PATH + " endpoint");
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function onMainWindowLoad({ window: _window }: { window: Window }): void {
  // No window modifications needed
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function onMainWindowUnload({ window: _window }: { window: Window }): void {
  // No window modifications needed
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function shutdown(
  { id, version, rootURI }: { id: string; version: string; rootURI: string },
  reason: number,
): void {
  void id;
  void version;
  void rootURI;
  if (reason === APP_SHUTDOWN) return;
  log("Shutting down " + PLUGIN_VERSION);
  delete Zotero.Server.Endpoints[FULLTEXT_ATTACH_PATH];
  delete Zotero.Server.Endpoints[LOCAL_WRITE_PATH];
  delete Zotero.Server.Endpoints[VERSION_PATH];
  AttachEndpoint = undefined;
  WriteEndpoint = undefined;
  VersionEndpoint = undefined;
  log("Unregistered " + FULLTEXT_ATTACH_PATH + " endpoint");
  log("Unregistered " + LOCAL_WRITE_PATH + " endpoint");
  log("Unregistered " + VERSION_PATH + " endpoint");
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function uninstall(): void {
  log("Uninstalled " + PLUGIN_VERSION);
}
