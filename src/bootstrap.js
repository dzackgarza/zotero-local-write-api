var AttachEndpoint;
var WriteEndpoint;
var VersionEndpoint;
var PLUGIN_VERSION = "3.1.9";
var FULLTEXT_ATTACH_PATH = "/attach";
var LOCAL_WRITE_PATH = "/write";
var VERSION_PATH = "/version";
var ADDON_ID = "local-write-api@dzackgarza.com";
var HOMEPAGE_URL = "https://github.com/dzackgarza/zotero-local-write-api";
var UPDATE_URL = "https://raw.githubusercontent.com/dzackgarza/zotero-local-write-api/main/updates.json";
var STRICT_MIN_VERSION = "7.0";
var STRICT_MAX_VERSION = "*";
var TESTED_ZOTERO_VERSION = "8.0.1";
var PLUGIN_CAPABILITIES = [
	"attach",
	"write",
	"version_probe",
];

function log(msg) {
	Zotero.debug("Local Write API: " + msg);
}

function sendJSON(sendResponse, statusCode, payload) {
	sendResponse(statusCode, "application/json", JSON.stringify(payload));
}

function successResult(operation, details, extra) {
	let payload = {
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

function errorResult(operation, stage, error, details) {
	return {
		success: false,
		operation: operation,
		stage: stage,
		error: error,
		details: details || {},
		version: PLUGIN_VERSION,
	};
}

function pluginVersionPayload() {
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

function requireString(value, fieldName) {
	if (typeof value !== "string") {
		throw new Error(fieldName + " must be a string");
	}
	return value;
}

function requireNonEmptyString(value, fieldName) {
	let cleaned = requireString(value, fieldName).trim();
	if (!cleaned) {
		throw new Error(fieldName + " must be a non-empty string");
	}
	return cleaned;
}

function requireObject(value, fieldName) {
	if (!value || Array.isArray(value) || typeof value !== "object") {
		throw new Error(fieldName + " must be an object");
	}
	return value;
}

function normalizeStringList(value, fieldName) {
	if (!Array.isArray(value)) {
		throw new Error(fieldName + " must be an array of strings");
	}
	let normalized = [];
	let seen = new Set();
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

function userLibraryID() {
	return Zotero.Libraries.userLibraryID;
}

async function getUserItemOrThrow(itemKey) {
	let item = await Zotero.Items.getByLibraryAndKey(userLibraryID(), itemKey);
	if (!item) {
		throw new Error("Item not found: " + itemKey);
	}
	return item;
}

async function getUserCollectionOrThrow(collectionKey) {
	let collection = await Zotero.Collections.getByLibraryAndKey(userLibraryID(), collectionKey);
	if (!collection) {
		throw new Error("Collection not found: " + collectionKey);
	}
	return collection;
}

function collectionDetails(collection) {
	return {
		collection_key: collection.key,
		collection_name: collection.name,
		parent_key: collection.parentKey || null,
	};
}

async function copyStoredAttachmentFiles(sourceAttachment, newAttachment) {
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

async function cloneChildAttachmentToParent(sourceAttachment, parentItemID) {
	let newAttachment = sourceAttachment.clone(sourceAttachment.libraryID);
	newAttachment.parentID = parentItemID;
	await newAttachment.saveTx();
	await copyStoredAttachmentFiles(sourceAttachment, newAttachment);
	return newAttachment;
}

async function handleFulltextAttach(data) {
	let itemKey = requireNonEmptyString(data.item_key, "item_key");
	let filePath = requireNonEmptyString(data.file_path, "file_path");
	let title = requireNonEmptyString(data.title, "title");

	let allowedDirs = ["/tmp", "/var/tmp"];
	if (!allowedDirs.some(dir => filePath.startsWith(dir))) {
		throw new Error(
			"File path must be within allowed directories: " + allowedDirs.join(", ")
		);
	}

	let parentItem = await getUserItemOrThrow(itemKey);
	let attachment = await Zotero.Attachments.importFromFile({
		file: filePath,
		parentItemID: parentItem.id,
		title: title,
	});
	if (!attachment) {
		throw new Error("Failed to create attachment");
	}

	await attachment.saveTx();
	return successResult(
		"attach_file_to_item",
		{
			parent_item_key: itemKey,
			file_path: filePath,
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

async function handleUpdateItemFields(data) {
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

async function handleReplaceItemJSON(data) {
	let itemKey = requireNonEmptyString(data.item_key, "item_key");
	let itemJSON = requireObject(data.item_json, "item_json");
	let item = await getUserItemOrThrow(itemKey);
	item.fromJSON(itemJSON);
	await item.saveTx();
	return successResult("replace_item_json", {
		item_key: itemKey,
		item_type: itemJSON.itemType || null,
	});
}

async function handleSetItemTags(data) {
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

async function handleSetItemCollections(data) {
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

async function handleAttachNote(data) {
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
			title: typeof data.title == "string" ? data.title : null,
		},
		{
			note_key: noteItem.key,
			note_id: noteItem.id,
		}
	);
}

async function handleUpdateNote(data) {
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
		parent_item_key: noteItem.parentKey || null,
		content_length: newContent.length,
	});
}

async function handleAttachURL(data) {
	let parentItemKey = requireNonEmptyString(data.parent_item_key, "parent_item_key");
	let url = requireNonEmptyString(data.url, "url");
	let parentItem = await getUserItemOrThrow(parentItemKey);
	let title = typeof data.title == "string" && data.title.trim() ? data.title.trim() : null;

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
			title: title || attachment.getField("title"),
		},
		{
			attachment_key: attachment.key,
			attachment_id: attachment.id,
		}
	);
}

async function handleTrashItem(data) {
	let itemKey = requireNonEmptyString(data.item_key, "item_key");
	let item = await getUserItemOrThrow(itemKey);
	item.deleted = true;
	await item.saveTx();
	return successResult("trash_item", {
		item_key: itemKey,
		item_type: item.itemType || item.itemTypeID || null,
	});
}

async function handleTrashCollection(data) {
	let collectionKey = requireNonEmptyString(data.collection_key, "collection_key");
	let collection = await getUserCollectionOrThrow(collectionKey);
	collection.deleted = true;
	await collection.saveTx();
	return successResult("trash_collection", collectionDetails(collection));
}

async function handleRelinkAttachmentFile(data) {
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

async function handleCreateCollection(data) {
	let name = requireNonEmptyString(data.name, "name");
	let parentKey = null;
	if (typeof data.parent_key == "string" && data.parent_key.trim()) {
		parentKey = data.parent_key.trim();
		await getUserCollectionOrThrow(parentKey);
	}

	let collection = new Zotero.Collection();
	collection.libraryID = userLibraryID();
	collection.name = name;
	if (parentKey) {
		collection.parentKey = parentKey;
	}
	await collection.saveTx();

	return successResult("create_collection", collectionDetails(collection));
}

async function handleRenameCollection(data) {
	let collectionKey = requireNonEmptyString(data.collection_key, "collection_key");
	let newName = requireNonEmptyString(data.new_name, "new_name");
	let collection = await getUserCollectionOrThrow(collectionKey);
	collection.name = newName;
	await collection.saveTx();

	return successResult("rename_collection", collectionDetails(collection));
}

async function handleMoveCollection(data) {
	let collectionKey = requireNonEmptyString(data.collection_key, "collection_key");
	let collection = await getUserCollectionOrThrow(collectionKey);
	let newParentKey = null;
	if (typeof data.new_parent_key == "string" && data.new_parent_key.trim()) {
		newParentKey = data.new_parent_key.trim();
		await getUserCollectionOrThrow(newParentKey);
	}
	collection.parentKey = newParentKey ? newParentKey : false;
	await collection.saveTx();

	return successResult("move_collection", collectionDetails(collection));
}

async function handleMergeCollections(data) {
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
		if (descendents.some(descendent => descendent.type == "collection" && descendent.key == targetKey)) {
			throw new Error("Cannot merge a collection into one of its descendants");
		}

		let childItems = sourceCollection.getChildItems(true, true);
		if (childItems.length) {
			await targetCollection.addItems(childItems);
			movedItems += childItems.length;
		}

		let childCollections = sourceCollection.getChildCollections(false, true);
		for (let childCollection of childCollections) {
			if (childCollection.key == targetKey) {
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

async function handleRenameTag(data) {
	let oldName = requireNonEmptyString(data.old_name, "old_name");
	let newName = requireNonEmptyString(data.new_name, "new_name");
	await Zotero.Tags.rename(userLibraryID(), oldName, newName);
	return successResult("rename_tag", {
		old_name: oldName,
		new_name: newName,
	});
}

async function handleMergeTags(data) {
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

async function handleDeleteTag(data) {
	let tagName = requireNonEmptyString(data.tag_name, "tag_name");
	let tagID = Zotero.Tags.getID(tagName);
	if (!tagID) {
		throw new Error("Tag not found: " + tagName);
	}
	await Zotero.Tags.removeFromLibrary(userLibraryID(), tagID);
	return successResult("delete_tag", {
		tag_name: tagName,
	});
}

async function handleDeleteUnusedTags(_data) {
	Zotero.Prefs.set("purge.tags", true);
	await Zotero.DB.executeTransaction(async function () {
		await Zotero.Tags.purge();
	});
	return successResult("delete_unused_tags", {});
}

async function handleCopyItem(data) {
	let itemKey = requireNonEmptyString(data.item_key, "item_key");
	let original = await getUserItemOrThrow(itemKey);
	let newItem = original.clone(original.libraryID, { includeCollections: true });
	if (newItem.isRegularItem()) {
		let currentTitle = newItem.getField("title");
		if (currentTitle) {
			newItem.setField("title", currentTitle + " (copy)");
		}
	}
	let newItemID = await newItem.saveTx();
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
		}
	);
}

async function handleMergeItems(data) {
	let sourceKey = requireNonEmptyString(data.source_key, "source_key");
	let targetKey = requireNonEmptyString(data.target_key, "target_key");
	if (sourceKey == targetKey) {
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

	let sourceTags = sourceItem.getTags();
	let targetTags = targetItem.getTags();
	let targetTagNames = new Set(targetTags.map(tag => tag.tag));
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
	let relationPredicates = Object.keys(sourceRelations);
	for (let predicate of relationPredicates) {
		let sourceValues = Array.isArray(sourceRelations[predicate])
			? sourceRelations[predicate]
			: [sourceRelations[predicate]];
		let targetValues = targetRelations[predicate]
			? (Array.isArray(targetRelations[predicate]) ? targetRelations[predicate] : [targetRelations[predicate]])
			: [];
		let targetValueSet = new Set(targetValues);
		for (let value of sourceValues) {
			if (!targetValueSet.has(value)) {
				targetValues.push(value);
				targetValueSet.add(value);
				transferred.relations++;
			}
		}
		targetItem.setRelations({ ...targetRelations, [predicate]: targetValues });
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

async function handleCreateItem(data) {
	let itemType = requireNonEmptyString(data.item_type, "item_type");
	let fields = data.fields ? requireObject(data.fields, "fields") : {};
	let tags = data.tags ? normalizeStringList(data.tags, "tags") : [];
	let collectionKeys = data.collection_keys
		? normalizeStringList(data.collection_keys, "collection_keys")
		: [];

	for (let collectionKey of collectionKeys) {
		await getUserCollectionOrThrow(collectionKey);
	}

	let item = new Zotero.Item(itemType);
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
		}
	);
}

async function handleAddItemTags(data) {
	let itemKey = requireNonEmptyString(data.item_key, "item_key");
	let tagsToAdd = normalizeStringList(data.tags, "tags");
	let item = await getUserItemOrThrow(itemKey);
	let existing = item.getTags();
	let existingNames = new Set(existing.map(t => t.tag));
	let added = [];
	for (let tag of tagsToAdd) {
		if (!existingNames.has(tag)) {
			existing.push({ tag: tag });
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

async function handleRemoveItemTags(data) {
	let itemKey = requireNonEmptyString(data.item_key, "item_key");
	let tagsToRemove = new Set(normalizeStringList(data.tags, "tags"));
	let item = await getUserItemOrThrow(itemKey);
	let filtered = item.getTags().filter(t => !tagsToRemove.has(t.tag));
	let removedCount = item.getTags().length - filtered.length;
	item.setTags(filtered);
	await item.saveTx();
	return successResult("remove_item_tags", {
		item_key: itemKey,
		removed_count: removedCount,
		remaining_tag_count: filtered.length,
	});
}

async function handleAddItemToCollection(data) {
	let itemKey = requireNonEmptyString(data.item_key, "item_key");
	let collectionKey = requireNonEmptyString(data.collection_key, "collection_key");
	let item = await getUserItemOrThrow(itemKey);
	let collection = await getUserCollectionOrThrow(collectionKey);
	await collection.addItems([item.id]);
	return successResult("add_item_to_collection", {
		item_key: itemKey,
		collection_key: collectionKey,
		collection_name: collection.name,
	});
}

async function handleRemoveItemFromCollection(data) {
	let itemKey = requireNonEmptyString(data.item_key, "item_key");
	let collectionKey = requireNonEmptyString(data.collection_key, "collection_key");
	let item = await getUserItemOrThrow(itemKey);
	let collection = await getUserCollectionOrThrow(collectionKey);
	await collection.removeItems([item.id]);
	return successResult("remove_item_from_collection", {
		item_key: itemKey,
		collection_key: collectionKey,
		collection_name: collection.name,
	});
}

function detectIdentifier(raw) {
	let doi = Zotero.Utilities.cleanDOI(raw);
	if (doi) {
		return { DOI: doi };
	}
	let isbn = Zotero.Utilities.cleanISBN(raw, false);
	if (isbn) {
		return { ISBN: isbn };
	}
	let arxivMatch = raw.match(/(?:arxiv:)?(\d{4}\.\d{4,}(?:v\d+)?|[a-z-]+\/\d{7})/i);
	if (arxivMatch) {
		return { arXiv: arxivMatch[1] };
	}
	if (/^\d{1,10}$/.test(raw.trim())) {
		return { PMID: raw.trim() };
	}
	return null;
}

async function handleImportByIdentifier(data) {
	let raw = requireNonEmptyString(data.identifier, "identifier");
	let identifier = detectIdentifier(raw);
	if (!identifier) {
		throw new Error("Could not detect identifier type for: " + raw);
	}
	let identifierType = Object.keys(identifier)[0];

	let search = new Zotero.Translate.Search();
	search.setIdentifier(identifier);
	let translators = await search.getTranslators();
	if (!translators || translators.length === 0) {
		throw new Error("No translator available for " + identifierType + ": " + raw);
	}
	search.setTranslator(translators);
	let items = await search.translate({
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

async function handleRestoreItem(data) {
	let itemKey = requireNonEmptyString(data.item_key, "item_key");
	let item = await getUserItemOrThrow(itemKey);
	item.deleted = false;
	await item.saveTx();
	return successResult("restore_item", {
		item_key: itemKey,
		item_type: item.itemType || item.itemTypeID || null,
	});
}

async function handleUpdateAttachmentTitle(data) {
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

async function runWrite(data) {
	let operation = requireNonEmptyString(data.operation, "operation");
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

function install() {
	log("Installed " + PLUGIN_VERSION);
}

async function startup({ id, version, rootURI }) {
	log("Starting " + PLUGIN_VERSION);

	AttachEndpoint = function() {};
	AttachEndpoint.prototype = {
		supportedMethods: ["POST"],
		supportedDataTypes: ["application/json"],
		init: async function(data, sendResponse) {
			try {
				log("Received POST request to " + FULLTEXT_ATTACH_PATH + " [v" + PLUGIN_VERSION + "]");
				sendJSON(sendResponse, 200, await handleFulltextAttach(data));
			}
			catch (error) {
				log("Error in " + FULLTEXT_ATTACH_PATH + " [v" + PLUGIN_VERSION + "]: " + error.message);
				sendJSON(
					sendResponse,
					500,
					errorResult(
						"attach_file_to_item",
						"attach_endpoint",
						error.message,
						{ request: data || {} }
					)
				);
			}
		}
	};

	WriteEndpoint = function() {};
	WriteEndpoint.prototype = {
		supportedMethods: ["POST"],
		supportedDataTypes: ["application/json"],
		init: async function(data, sendResponse) {
			try {
				let operation = data && data.operation ? data.operation : "unknown_operation";
				log("Received POST request to " + LOCAL_WRITE_PATH + " [operation=" + operation + "]");
				sendJSON(sendResponse, 200, await runWrite(data || {}));
			}
			catch (error) {
				let operation = data && data.operation ? data.operation : "unknown_operation";
				log("Error in " + LOCAL_WRITE_PATH + " [operation=" + operation + "]: " + error.message);
				sendJSON(
					sendResponse,
					500,
					errorResult(
						operation,
						"write_endpoint",
						error.message,
						{ request: data || {} }
					)
				);
			}
		}
	};

	VersionEndpoint = function() {};
	VersionEndpoint.prototype = {
		supportedMethods: ["GET"],
		init: function(data, sendResponse) {
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

function onMainWindowLoad({ window }) {
	// No window modifications needed
}

function onMainWindowUnload({ window }) {
	// No window modifications needed
}

function shutdown({ id, version, rootURI }, reason) {
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

function uninstall() {
	log("Uninstalled " + PLUGIN_VERSION);
}
