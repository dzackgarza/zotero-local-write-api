// APP_SHUTDOWN is a Zotero bootstrap constant not in zotero-types
declare const APP_SHUTDOWN: number;

let AttachEndpoint: any;
let WriteEndpoint: any;
let VersionEndpoint: any;

const PLUGIN_VERSION = "3.2.0-dev";
const FULLTEXT_ATTACH_PATH = "/attach";
const LOCAL_WRITE_PATH = "/write";
const VERSION_PATH = "/version";
const FULLTEXT_ALLOWED_DIRS = ["/tmp", "/var/tmp"];
const ADDON_ID = "local-write-api@dzackgarza.com";
const HOMEPAGE_URL = "https://github.com/dzackgarza/zotero-local-write-api";
const UPDATE_URL = "https://raw.githubusercontent.com/dzackgarza/zotero-local-write-api/main/updates.json";
const STRICT_MIN_VERSION = "7.0";
const STRICT_MAX_VERSION = "*";
const TESTED_ZOTERO_VERSION = "8.0.1";
const PLUGIN_CAPABILITIES = [
	"attach",
	"attach_bytes",
	"write",
	"version_probe",
];

type RequestData = Record<string, unknown>;
type SendResponse = (status: number, contentType: string, body: string) => void;
type JsonPayload = Record<string, unknown>;
type TagEntry = { tag: string; type: number };
type Relations = Record<string, string | string[]>;

function log(msg: string): void {
	Zotero.debug("Local Write API: " + msg);
}

function sendJSON(sendResponse: SendResponse, statusCode: number, payload: JsonPayload): void {
	sendResponse(statusCode, "application/json", JSON.stringify(payload));
}

function successResult(operation: string, details?: JsonPayload, extra?: JsonPayload): JsonPayload {
	const payload: JsonPayload = {
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

function errorResult(operation: string, stage: string, error: string, details?: JsonPayload): JsonPayload {
	return {
		success: false,
		operation: operation,
		stage: stage,
		error: error,
		details: details ?? {},
		version: PLUGIN_VERSION,
	};
}

function pluginVersionPayload(): JsonPayload {
	return {
		success: true,
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
	const cleaned = requireString(value, fieldName).trim();
	if (!cleaned) {
		throw new Error(fieldName + " must be a non-empty string");
	}
	return cleaned;
}

function optionalNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const cleaned = value.trim();
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
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "string") {
			throw new Error(fieldName + " entries must be strings");
		}
		const cleaned = entry.trim();
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

async function getUserItemOrThrow(itemKey: string): Promise<Zotero.Item> {
	const item = await Zotero.Items.getByLibraryAndKey(userLibraryID(), itemKey);
	if (!item) {
		throw new Error("Item not found: " + itemKey);
	}
	return item;
}

async function getUserCollectionOrThrow(collectionKey: string): Promise<Zotero.Collection> {
	const collection = await Zotero.Collections.getByLibraryAndKey(userLibraryID(), collectionKey);
	if (!collection) {
		throw new Error("Collection not found: " + collectionKey);
	}
	return collection;
}

function collectionDetails(collection: Zotero.Collection): JsonPayload {
	return {
		collection_key: collection.key,
		collection_name: collection.name,
		parent_key: collection.parentKey || null,
	};
}

async function copyStoredAttachmentFiles(sourceAttachment: Zotero.Item, newAttachment: Zotero.Item): Promise<void> {
	if (!sourceAttachment.isStoredFileAttachment()) {
		return;
	}
	if (!(await sourceAttachment.fileExists())) {
		return;
	}
	const sourceDir = Zotero.Attachments.getStorageDirectory(sourceAttachment);
	const destDir = await Zotero.Attachments.createDirectoryForItem(newAttachment);
	await Zotero.File.copyDirectory(sourceDir, destDir);
}

async function cloneChildAttachmentToParent(sourceAttachment: Zotero.Item, parentItemID: number): Promise<Zotero.Item> {
	const newAttachment = sourceAttachment.clone(sourceAttachment.libraryID);
	newAttachment.parentID = parentItemID;
	await newAttachment.saveTx();
	await copyStoredAttachmentFiles(sourceAttachment, newAttachment);
	return newAttachment;
}

function resolveAttachFilePath(filePath: string): string {
	const file = Zotero.File.pathToFile(filePath);
	if (!file.exists()) {
		throw new Error("File not found: " + filePath);
	}
	return file.path;
}

function isMissingFileError(error: unknown): boolean {
	return typeof (error as Error).message === "string"
		&& (error as Error).message.includes("NS_ERROR_FILE_NOT_FOUND");
}

async function materializeUploadBytes(fileName: string, fileBytesBase64: string): Promise<string> {
	const tempDir = Zotero.getTempDirectory();
	const safeFileName = Zotero.File.getValidFileName(fileName.trim()) || "attachment.bin";
	tempDir.append(`local-write-api-${Date.now()}-${Math.random().toString(16).slice(2)}-${safeFileName}`);
	const binary = atob(fileBytesBase64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index);
	}
	// Zotero.File.putContentsAsync() accepts Blob at runtime, but zotero-types
	// only advertises string | ArrayBuffer | nsIInputStream.
	await Zotero.File.putContentsAsync(tempDir.path, new Blob([bytes]) as unknown as ArrayBuffer);
	return tempDir.path;
}

async function importStoredAttachment(parentItem: Zotero.Item, filePath: string, title: string): Promise<Zotero.Item> {
	const resolvedFilePath = resolveAttachFilePath(filePath);
	const attachment = await Zotero.Attachments.importFromFile({
		file: resolvedFilePath,
		libraryID: parentItem.libraryID,
		parentItemID: parentItem.id,
		title: title,
	});
	if (!attachment) {
		throw new Error("Failed to create attachment");
	}
	await attachment.saveTx();
	return attachment;
}

async function handleFulltextAttach(data: RequestData): Promise<JsonPayload> {
	const itemKey = requireNonEmptyString(data.item_key, "item_key");
	const title = requireNonEmptyString(data.title, "title");
	const filePath = optionalNonEmptyString(data.file_path);
	const fileName = optionalNonEmptyString(data.file_name);
	const fileBytesBase64 = optionalNonEmptyString(data.file_bytes_base64);

	if (!filePath && !fileBytesBase64) {
		throw new Error("Either file_path or file_bytes_base64 must be provided");
	}

	const parentItem = await getUserItemOrThrow(itemKey);
	let attachment: Zotero.Item;
	let sourceMode = "path";
	let tempPath: string | null = null;

	try {
		if (filePath) {
			if (!FULLTEXT_ALLOWED_DIRS.some(dir => filePath.startsWith(dir))) {
				throw new Error(
					"File path must be within allowed directories: " + FULLTEXT_ALLOWED_DIRS.join(", ")
				);
			}
			try {
				attachment = await importStoredAttachment(parentItem, filePath, title);
			}
			catch (error) {
				if (!fileBytesBase64 || !isMissingFileError(error)) {
					throw error;
				}
				const fallbackName = fileName || Zotero.File.pathToFile(filePath).leafName || "attachment.bin";
				tempPath = await materializeUploadBytes(fallbackName, fileBytesBase64);
				attachment = await importStoredAttachment(parentItem, tempPath, title);
				sourceMode = "bytes_fallback";
			}
		}
		else {
			const requiredFileName = requireNonEmptyString(data.file_name, "file_name");
			tempPath = await materializeUploadBytes(requiredFileName, requireNonEmptyString(data.file_bytes_base64, "file_bytes_base64"));
			attachment = await importStoredAttachment(parentItem, tempPath, title);
			sourceMode = "bytes";
		}
	}
	finally {
		if (tempPath) {
			try {
				Zotero.File.pathToFile(tempPath).remove(false);
			}
			catch (error) {
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
		}
	);
}

async function handleUpdateItemFields(data: RequestData): Promise<JsonPayload> {
	const itemKey = requireNonEmptyString(data.item_key, "item_key");
	const fields = requireObject(data.fields, "fields");
	const item = await getUserItemOrThrow(itemKey);
	const json = item.toJSON();
	Object.assign(json, fields);
	item.fromJSON(json);
	await item.saveTx();
	return successResult("update_item_fields", {
		item_key: itemKey,
		field_names: Object.keys(fields).sort(),
	});
}

async function handleReplaceItemJSON(data: RequestData): Promise<JsonPayload> {
	const itemKey = requireNonEmptyString(data.item_key, "item_key");
	const itemJSON = requireObject(data.item_json, "item_json");
	const item = await getUserItemOrThrow(itemKey);
	item.fromJSON(itemJSON);
	await item.saveTx();
	return successResult("replace_item_json", {
		item_key: itemKey,
		item_type: (itemJSON.itemType as string) || null,
	});
}

async function handleSetItemTags(data: RequestData): Promise<JsonPayload> {
	const itemKey = requireNonEmptyString(data.item_key, "item_key");
	const tags = normalizeStringList(data.tags, "tags");
	const item = await getUserItemOrThrow(itemKey);
	item.setTags(tags);
	await item.saveTx();
	return successResult("set_item_tags", {
		item_key: itemKey,
		tags: tags,
		tag_count: tags.length,
	});
}

async function handleSetItemCollections(data: RequestData): Promise<JsonPayload> {
	const itemKey = requireNonEmptyString(data.item_key, "item_key");
	const collectionKeys = normalizeStringList(data.collection_keys, "collection_keys");
	for (const collectionKey of collectionKeys) {
		await getUserCollectionOrThrow(collectionKey);
	}
	const item = await getUserItemOrThrow(itemKey);
	item.setCollections(collectionKeys);
	await item.saveTx();
	return successResult("set_item_collections", {
		item_key: itemKey,
		collection_keys: collectionKeys,
	});
}

async function handleAttachNote(data: RequestData): Promise<JsonPayload> {
	const parentItemKey = requireNonEmptyString(data.parent_item_key, "parent_item_key");
	const noteText = requireString(data.note_text, "note_text");
	const parentItem = await getUserItemOrThrow(parentItemKey);

	const noteItem = new Zotero.Item("note");
	// libraryID is readonly in zotero-types but writable on unsaved items
	(noteItem as unknown as { libraryID: number }).libraryID = parentItem.libraryID;
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
		}
	);
}

async function handleUpdateNote(data: RequestData): Promise<JsonPayload> {
	const noteKey = requireNonEmptyString(data.note_key, "note_key");
	const newContent = requireString(data.new_content, "new_content");
	const noteItem = await getUserItemOrThrow(noteKey);
	if (!noteItem.isNote()) {
		throw new Error("Item is not a note: " + noteKey);
	}
	noteItem.setNote(newContent);
	await noteItem.saveTx();

	return successResult("update_note", {
		note_key: noteKey,
		parent_item_key: noteItem.parentKey || null,
		content_length: newContent.length,
	});
}

async function handleAttachURL(data: RequestData): Promise<JsonPayload> {
	const parentItemKey = requireNonEmptyString(data.parent_item_key, "parent_item_key");
	const url = requireNonEmptyString(data.url, "url");
	const parentItem = await getUserItemOrThrow(parentItemKey);
	const title = typeof data.title === "string" && data.title.trim() ? data.title.trim() : null;

	const attachment = await Zotero.Attachments.linkFromURL({
		url: url,
		parentItemID: parentItem.id,
		title: title,
	});

	return successResult(
		"attach_url",
		{
			parent_item_key: parentItemKey,
			url: url,
			title: title || attachment.getField("title"),
		},
		{
			attachment_key: attachment.key,
			attachment_id: attachment.id,
		}
	);
}

async function handleTrashItem(data: RequestData): Promise<JsonPayload> {
	const itemKey = requireNonEmptyString(data.item_key, "item_key");
	const item = await getUserItemOrThrow(itemKey);
	item.deleted = true;
	await item.saveTx();
	return successResult("trash_item", {
		item_key: itemKey,
		item_type: item.itemType || item.itemTypeID || null,
	});
}

async function handleTrashCollection(data: RequestData): Promise<JsonPayload> {
	const collectionKey = requireNonEmptyString(data.collection_key, "collection_key");
	const collection = await getUserCollectionOrThrow(collectionKey);
	collection.deleted = true;
	await collection.saveTx();
	return successResult("trash_collection", collectionDetails(collection));
}

async function handleRelinkAttachmentFile(data: RequestData): Promise<JsonPayload> {
	const attachmentKey = requireNonEmptyString(data.attachment_key, "attachment_key");
	const filePath = requireNonEmptyString(data.file_path, "file_path");
	const attachment = await getUserItemOrThrow(attachmentKey);
	if (!attachment.isAttachment()) {
		throw new Error("Item is not an attachment: " + attachmentKey);
	}
	await attachment.relinkAttachmentFile(filePath);
	return successResult("relink_attachment_file", {
		attachment_key: attachmentKey,
		file_path: filePath,
	});
}

async function handleCreateCollection(data: RequestData): Promise<JsonPayload> {
	const name = requireNonEmptyString(data.name, "name");
	let parentKey: string | null = null;
	if (typeof data.parent_key === "string" && data.parent_key.trim()) {
		parentKey = data.parent_key.trim();
		await getUserCollectionOrThrow(parentKey);
	}

	const collection = new Zotero.Collection({ libraryID: userLibraryID(), name });
	if (parentKey) {
		collection.parentKey = parentKey;
	}
	await collection.saveTx();

	return successResult("create_collection", collectionDetails(collection));
}

async function handleRenameCollection(data: RequestData): Promise<JsonPayload> {
	const collectionKey = requireNonEmptyString(data.collection_key, "collection_key");
	const newName = requireNonEmptyString(data.new_name, "new_name");
	const collection = await getUserCollectionOrThrow(collectionKey);
	collection.name = newName;
	await collection.saveTx();

	return successResult("rename_collection", collectionDetails(collection));
}

async function handleMoveCollection(data: RequestData): Promise<JsonPayload> {
	const collectionKey = requireNonEmptyString(data.collection_key, "collection_key");
	const collection = await getUserCollectionOrThrow(collectionKey);
	let newParentKey: string | null = null;
	if (typeof data.new_parent_key === "string" && data.new_parent_key.trim()) {
		newParentKey = data.new_parent_key.trim();
		await getUserCollectionOrThrow(newParentKey);
	}
	// zotero-types types parentKey as string but Zotero accepts false to remove a parent
	(collection as unknown as { parentKey: string | false }).parentKey = newParentKey ?? false;
	await collection.saveTx();

	return successResult("move_collection", collectionDetails(collection));
}

async function handleMergeCollections(data: RequestData): Promise<JsonPayload> {
	const sourceKeys = normalizeStringList(data.source_keys, "source_keys");
	const targetKey = requireNonEmptyString(data.target_key, "target_key");
	if (sourceKeys.includes(targetKey)) {
		throw new Error("Target collection cannot also be a source collection");
	}
	const targetCollection = await getUserCollectionOrThrow(targetKey);
	let movedItems = 0;
	let movedChildren = 0;
	let trashedSources = 0;

	for (const sourceKey of sourceKeys) {
		const sourceCollection = await getUserCollectionOrThrow(sourceKey);
		const descendents = sourceCollection.getDescendents(false, null, false);
		if (descendents.some(d => d.type === "collection" && d.key === targetKey)) {
			throw new Error("Cannot merge a collection into one of its descendants");
		}

		const childItems = sourceCollection.getChildItems(true, true);
		if (childItems.length) {
			await targetCollection.addItems(childItems);
			movedItems += childItems.length;
		}

		const childCollections = sourceCollection.getChildCollections(false, true);
		for (const childCollection of childCollections) {
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

async function handleRenameTag(data: RequestData): Promise<JsonPayload> {
	const oldName = requireNonEmptyString(data.old_name, "old_name");
	const newName = requireNonEmptyString(data.new_name, "new_name");
	await Zotero.Tags.rename(userLibraryID(), oldName, newName);
	return successResult("rename_tag", {
		old_name: oldName,
		new_name: newName,
	});
}

async function handleMergeTags(data: RequestData): Promise<JsonPayload> {
	const sourceTags = normalizeStringList(data.source_tags, "source_tags");
	const targetTag = requireNonEmptyString(data.target_tag, "target_tag");
	for (const sourceTag of sourceTags) {
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

async function handleDeleteTag(data: RequestData): Promise<JsonPayload> {
	const tagName = requireNonEmptyString(data.tag_name, "tag_name");
	const tagID = Zotero.Tags.getID(tagName);
	if (!tagID) {
		throw new Error("Tag not found: " + tagName);
	}

	const search = new Zotero.Search();
	(search as unknown as { libraryID: number }).libraryID = userLibraryID();
	search.addCondition("tag", "is", tagName);
	const itemIDs = await search.search();

	let modifiedCount = 0;
	if (itemIDs && itemIDs.length > 0) {
		const items = await Zotero.Items.getAsync(itemIDs);
		for (const item of items) {
			if (item.removeTag(tagName)) {
				await item.saveTx();
				modifiedCount++;
			}
		}
	}

	await Zotero.Tags.removeFromLibrary(
		userLibraryID(),
		[tagID],
		() => {},
		undefined as unknown as number[],
	);

	return successResult("delete_tag", {
		tag_name: tagName,
		modified_item_count: modifiedCount,
	});
}

async function handleDeleteUnusedTags(_data: RequestData): Promise<JsonPayload> {
	Zotero.Prefs.set("purge.tags", true);
	await Zotero.DB.executeTransaction(async function () {
		await Zotero.Tags.purge();
	});
	return successResult("delete_unused_tags", {});
}

async function handleCopyItem(data: RequestData): Promise<JsonPayload> {
	const itemKey = requireNonEmptyString(data.item_key, "item_key");
	const original = await getUserItemOrThrow(itemKey);
	const newItem = original.clone(original.libraryID, { includeCollections: true });
	if (newItem.isRegularItem()) {
		const currentTitle = newItem.getField("title");
		if (currentTitle) {
			newItem.setField("title", currentTitle + " (copy)");
		}
	}
	// saveTx() returns number | boolean in zotero-types; for a new item it is always the numeric ID
	const newItemID = await newItem.saveTx() as number;
	const newItemKey = newItem.key;
	let copiedNotes = 0;
	let copiedAttachments = 0;

	if (original.isAttachment()) {
		await copyStoredAttachmentFiles(original, newItem);
	}

	if (original.isRegularItem()) {
		const noteIDs = original.getNotes(true);
		for (const note of Zotero.Items.get(noteIDs)) {
			const newNote = note.clone(original.libraryID);
			newNote.parentID = newItemID;
			await newNote.saveTx();
			copiedNotes++;
		}

		const attachmentIDs = original.getAttachments(true);
		for (const attachment of Zotero.Items.get(attachmentIDs)) {
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
		}
	);
}

async function handleMergeItems(data: RequestData): Promise<JsonPayload> {
	const sourceKey = requireNonEmptyString(data.source_key, "source_key");
	const targetKey = requireNonEmptyString(data.target_key, "target_key");
	if (sourceKey === targetKey) {
		throw new Error("Source and target items must be different");
	}

	const sourceItem = await getUserItemOrThrow(sourceKey);
	const targetItem = await getUserItemOrThrow(targetKey);
	if (!sourceItem.isRegularItem() || !targetItem.isRegularItem()) {
		throw new Error("merge_items requires two regular Zotero items");
	}
	const transferred = {
		attachments: 0,
		notes: 0,
		tags: 0,
		relations: 0,
	};

	const sourceTags = sourceItem.getTags() as TagEntry[];
	const targetTags = targetItem.getTags() as TagEntry[];
	const targetTagNames = new Set(targetTags.map(tag => tag.tag));
	for (const tag of sourceTags) {
		if (!targetTagNames.has(tag.tag)) {
			targetTags.push(tag);
			targetTagNames.add(tag.tag);
			transferred.tags++;
		}
	}
	targetItem.setTags(targetTags);

	const sourceRelations = sourceItem.getRelations() as unknown as Relations;
	let targetRelations = targetItem.getRelations() as unknown as Relations;
	for (const predicate of Object.keys(sourceRelations)) {
		const rawSource = sourceRelations[predicate];
		const sourceValues: string[] = Array.isArray(rawSource) ? rawSource : [rawSource];
		const rawTarget = targetRelations[predicate];
		const targetValues: string[] = rawTarget
			? (Array.isArray(rawTarget) ? rawTarget : [rawTarget])
			: [];
		const targetValueSet = new Set(targetValues);
		for (const value of sourceValues) {
			if (!targetValueSet.has(value)) {
				targetValues.push(value);
				targetValueSet.add(value);
				transferred.relations++;
			}
		}
		targetItem.setRelations({ ...targetRelations, [predicate]: targetValues } as any);
		targetRelations = targetItem.getRelations() as unknown as Relations;
	}
	await targetItem.saveTx();

	for (const note of Zotero.Items.get(sourceItem.getNotes(true))) {
		note.parentID = targetItem.id;
		await note.saveTx();
		transferred.notes++;
	}
	for (const attachment of Zotero.Items.get(sourceItem.getAttachments(true))) {
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

async function handleCreateItem(data: RequestData): Promise<JsonPayload> {
	const itemType = requireNonEmptyString(data.item_type, "item_type");
	const fields = data.fields ? requireObject(data.fields, "fields") : {};
	const tags = data.tags ? normalizeStringList(data.tags, "tags") : [];
	const collectionKeys = data.collection_keys
		? normalizeStringList(data.collection_keys, "collection_keys")
		: [];

	for (const collectionKey of collectionKeys) {
		await getUserCollectionOrThrow(collectionKey);
	}

	// itemType is user-supplied and validated at runtime
	const item = new Zotero.Item(itemType as any);
	// libraryID is readonly in zotero-types but writable on unsaved items
	(item as unknown as { libraryID: number }).libraryID = userLibraryID();

	const json = item.toJSON();
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
		}
	);
}

async function handleAddItemTags(data: RequestData): Promise<JsonPayload> {
	const itemKey = requireNonEmptyString(data.item_key, "item_key");
	const tagsToAdd = normalizeStringList(data.tags, "tags");
	const item = await getUserItemOrThrow(itemKey);
	const existing = item.getTags() as TagEntry[];
	const existingNames = new Set(existing.map(t => t.tag));
	const added: string[] = [];
	for (const tag of tagsToAdd) {
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

async function handleRemoveItemTags(data: RequestData): Promise<JsonPayload> {
	const itemKey = requireNonEmptyString(data.item_key, "item_key");
	const tagsToRemove = new Set(normalizeStringList(data.tags, "tags"));
	const item = await getUserItemOrThrow(itemKey);
	const allTags = item.getTags() as TagEntry[];
	const removedCount = allTags.filter(t => tagsToRemove.has(t.tag)).length;
	const filtered = allTags.filter(t => !tagsToRemove.has(t.tag));
	item.setTags(filtered);
	await item.saveTx();
	return successResult("remove_item_tags", {
		item_key: itemKey,
		removed_count: removedCount,
		remaining_tag_count: filtered.length,
	});
}

async function handleAddItemToCollection(data: RequestData): Promise<JsonPayload> {
	const itemKey = requireNonEmptyString(data.item_key, "item_key");
	const collectionKey = requireNonEmptyString(data.collection_key, "collection_key");
	const item = await getUserItemOrThrow(itemKey);
	const collection = await getUserCollectionOrThrow(collectionKey);
	const currentKeys = item.getCollections().map(id => Zotero.Collections.get(id).key);
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

async function handleRemoveItemFromCollection(data: RequestData): Promise<JsonPayload> {
	const itemKey = requireNonEmptyString(data.item_key, "item_key");
	const collectionKey = requireNonEmptyString(data.collection_key, "collection_key");
	const item = await getUserItemOrThrow(itemKey);
	const collection = await getUserCollectionOrThrow(collectionKey);
	const currentKeys = item.getCollections()
		.map(id => Zotero.Collections.get(id).key)
		.filter(k => k !== collectionKey);
	item.setCollections(currentKeys);
	await item.saveTx();
	return successResult("remove_item_from_collection", {
		item_key: itemKey,
		collection_key: collectionKey,
		collection_name: collection.name,
	});
}

function detectIdentifier(raw: string): Record<string, string> | null {
	const doi = Zotero.Utilities.cleanDOI(raw);
	if (doi) {
		return { DOI: doi };
	}
	const isbn = Zotero.Utilities.cleanISBN(raw, false);
	if (isbn) {
		return { ISBN: isbn };
	}
	const arxivMatch = raw.match(/(?:arxiv:)?(\d{4}\.\d{4,}(?:v\d+)?|[a-z][a-z0-9\-.]+\/\d{7})/i);
	if (arxivMatch) {
		return { arXiv: arxivMatch[1] };
	}
	if (/^\d{1,10}$/.test(raw.trim())) {
		return { PMID: raw.trim() };
	}
	return null;
}

async function handleImportByIdentifier(data: RequestData): Promise<JsonPayload> {
	const raw = requireNonEmptyString(data.identifier, "identifier");
	const identifier = detectIdentifier(raw);
	if (!identifier) {
		throw new Error("Could not detect identifier type for: " + raw);
	}
	const identifierType = Object.keys(identifier)[0];

	const search = new Zotero.Translate.Search();
	search.setIdentifier(identifier);
	const translators = await search.getTranslators();
	if (!translators || translators.length === 0) {
		throw new Error("No translator available for " + identifierType + ": " + raw);
	}
	search.setTranslator(translators);
	const items = await search.translate({
		libraryID: userLibraryID(),
		collections: [],
	});
	if (!items || items.length === 0) {
		throw new Error("No item found for " + identifierType + ": " + raw);
	}

	return successResult(
		"import_by_identifier",
		{
			identifier: raw,
			identifier_type: identifierType,
			item_count: items.length,
		},
		{
			item_key: items[0].key,
			item_id: items[0].id,
		}
	);
}

async function handleRestoreItem(data: RequestData): Promise<JsonPayload> {
	const itemKey = requireNonEmptyString(data.item_key, "item_key");
	const item = await getUserItemOrThrow(itemKey);
	item.deleted = false;
	await item.saveTx();
	return successResult("restore_item", {
		item_key: itemKey,
		item_type: item.itemType || item.itemTypeID || null,
	});
}

async function handleUpdateAttachmentTitle(data: RequestData): Promise<JsonPayload> {
	const attachmentKey = requireNonEmptyString(data.attachment_key, "attachment_key");
	const newTitle = requireNonEmptyString(data.new_title, "new_title");
	const attachment = await getUserItemOrThrow(attachmentKey);
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

async function runWrite(data: RequestData): Promise<JsonPayload> {
	const operation = requireNonEmptyString(data.operation, "operation");
	switch (operation) {
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
		case "import_by_identifier":
			return handleImportByIdentifier(data);
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
async function startup({ id, version, rootURI }: { id: string; version: string; rootURI: string }): Promise<void> {
	void id; void version; void rootURI;
	log("Starting " + PLUGIN_VERSION);

	AttachEndpoint = function() {};
	AttachEndpoint.prototype = {
		supportedMethods: ["POST"],
		supportedDataTypes: ["application/json"],
		init: async function(data: RequestData, sendResponse: SendResponse) {
			try {
				log("Received POST request to " + FULLTEXT_ATTACH_PATH + " [v" + PLUGIN_VERSION + "]");
				sendJSON(sendResponse, 200, await handleFulltextAttach(data));
			}
			catch (error) {
				const msg = (error as Error).message;
				log("Error in " + FULLTEXT_ATTACH_PATH + " [v" + PLUGIN_VERSION + "]: " + msg);
				sendJSON(
					sendResponse,
					500,
					errorResult(
						"attach_file_to_item",
						"attach_endpoint",
						msg,
						{ request: data ?? {} }
					)
				);
			}
		}
	};

	WriteEndpoint = function() {};
	WriteEndpoint.prototype = {
		supportedMethods: ["POST"],
		supportedDataTypes: ["application/json"],
		init: async function(data: RequestData, sendResponse: SendResponse) {
			try {
				const operation = data?.operation ?? "unknown_operation";
				log("Received POST request to " + LOCAL_WRITE_PATH + " [operation=" + operation + "]");
				sendJSON(sendResponse, 200, await runWrite(data ?? {}));
			}
			catch (error) {
				const operation = data?.operation ?? "unknown_operation";
				const msg = (error as Error).message;
				log("Error in " + LOCAL_WRITE_PATH + " [operation=" + operation + "]: " + msg);
				sendJSON(
					sendResponse,
					500,
					errorResult(
						String(operation),
						"write_endpoint",
						msg,
						{ request: data ?? {} }
					)
				);
			}
		}
	};

	VersionEndpoint = function() {};
	VersionEndpoint.prototype = {
		supportedMethods: ["GET"],
		init: function(_data: unknown, sendResponse: SendResponse) {
			log("Received GET request to " + VERSION_PATH + " [v" + PLUGIN_VERSION + "]");
			sendJSON(sendResponse, 200, pluginVersionPayload());
		}
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
function shutdown({ id, version, rootURI }: { id: string; version: string; rootURI: string }, reason: number): void {
	void id; void version; void rootURI;
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
