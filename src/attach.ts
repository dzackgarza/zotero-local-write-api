import { assertNever, badRequest, isApiError, notFound } from "./errors";
import { getUserItemOrThrow, selectedCollection, userLibraryID } from "./library";
import { optionalNonEmptyString, requireNonEmptyString, requirePresent, requireRequestObject } from "./request-fields";
import { type EndpointResult, type RequestData, errorResult, jsonResult, log, successResult } from "./responses";

function resolveAttachFilePath(filePath: string): string {
  let file = Zotero.File.pathToFile(filePath);
  if (!file.exists()) {
    throw notFound("File not found: " + filePath);
  }
  return file.path;
}

async function materializeUploadBytes(fileName: string, fileBytesBase64: string) {
  let tempDir = Zotero.getTempDirectory();
  let safeFileName = Zotero.File.getValidFileName(fileName.trim());
  if (!safeFileName) {
    throw badRequest("File name has no valid characters: " + fileName);
  }
  tempDir.append(
    `local-write-api-${Date.now()}-${Math.random().toString(16).slice(2)}-${safeFileName}`,
  );
  let binary = atob(fileBytesBase64);
  let bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  // Mirrors putContentsAsync's own Blob handling (zotero/zotero
  // chrome/content/zotero/xpcom/file.js:411): it converts a Blob to an
  // nsIArrayBufferInputStream because NetUtil.asyncCopy needs a real stream.
  // Building the stream here hits the declared nsIInputStream signature
  // directly; the advertised ArrayBuffer does not work at runtime.
  let stream = Cc["@mozilla.org/io/arraybuffer-input-stream;1"].createInstance(
    Ci.nsIArrayBufferInputStream,
  );
  stream.setData(bytes.buffer, 0, bytes.byteLength);
  await Zotero.File.putContentsAsync(tempDir.path, stream);
  return tempDir.path;
}

// Where a stored file lands: under the parent item with this key, or standalone in the
// given collections, where no collection means the library root.
type AttachTarget =
  | { kind: "child"; parentItemKey: string }
  | { kind: "standalone"; collections: number[] };

// Loads the parent from the database instead of trusting the object cache. Models zotero/zotero
// chrome/content/zotero/xpcom/db.js executeTransaction: a caller that times out waiting for
// the active transaction runs that transaction's rollback callbacks, and DataObject._initSave
// registers Zotero.Items.unload(id) as one for each new item. The transaction still commits,
// so a just-imported parent can exist in the database while its cache entries are gone, and
// Zotero.Attachments.importFromFile then reads libraryID undefined for it.
async function loadParentItem(itemKey: string): Promise<Zotero.Item> {
  let itemID = await Zotero.DB.valueQueryAsync<number>(
    "SELECT itemID FROM items WHERE libraryID=? AND key=?",
    [userLibraryID(), itemKey],
  );
  if (typeof itemID !== "number") {
    throw notFound("Item not found: " + itemKey);
  }
  let item = await Zotero.Items.getAsync(itemID);
  if (item === false) {
    throw notFound("Item not found: " + itemKey);
  }
  return item;
}

// The placement fields Zotero.Attachments.importFromFile takes for a target.
async function importPlacement(
  target: AttachTarget,
): Promise<{ parentItemID: number } | { collections: number[] }> {
  switch (target.kind) {
    case "child":
      return { parentItemID: (await loadParentItem(target.parentItemKey)).id };
    case "standalone":
      return { collections: target.collections };
    default:
      return assertNever(target);
  }
}

async function importStoredAttachment(
  target: AttachTarget,
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
    let placement = await importPlacement(target);
    let result = await Zotero.Attachments.importFromFile({
      file: tempFile.path,
      libraryID: userLibraryID(),
      title: title,
      ...placement,
    });
    await result.saveTx();
    attachment = result;
  } finally {
    if (tempFile.exists()) {
      tempFile.remove(false);
    }
  }
  return attachment;
}

// The file an /attach request stores: the request's bytes, or a path on this machine.
type AttachSource =
  | { kind: "bytes"; fileName: string; bytes: string }
  | { kind: "path"; filePath: string };

async function importUploadedBytes(
  target: AttachTarget,
  title: string,
  fileName: string,
  bytes: string,
): Promise<Zotero.Item> {
  let tempPath = await materializeUploadBytes(fileName, bytes);
  try {
    return await importStoredAttachment(target, tempPath, title);
  } finally {
    try {
      Zotero.File.pathToFile(tempPath).remove(false);
    } catch (error) {
      Zotero.logError(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

// Bytes in the request are the file's content and are stored as sent; their name is
// file_name, or the basename of file_path when file_name is absent.
function attachSource(
  filePath: string | null,
  fileName: string | null,
  bytes: string | null,
): AttachSource {
  if (bytes === null) {
    return {
      kind: "path",
      filePath: requirePresent(filePath, "Either file_path or file_bytes_base64 must be provided"),
    };
  }
  let name =
    fileName ??
    Zotero.File.pathToFile(requirePresent(filePath, "file_name must be a non-empty string"))
      .leafName;
  return { kind: "bytes", fileName: name, bytes };
}

async function storeAttachmentFile(
  target: AttachTarget,
  title: string,
  source: AttachSource,
): Promise<{ attachment: Zotero.Item; sourceMode: AttachSource["kind"] }> {
  switch (source.kind) {
    case "bytes":
      return {
        attachment: await importUploadedBytes(target, title, source.fileName, source.bytes),
        sourceMode: "bytes",
      };
    case "path":
      if (!FULLTEXT_ALLOWED_DIRS.some((dir) => source.filePath.startsWith(dir))) {
        throw badRequest(
          "File path must be within allowed directories: " + FULLTEXT_ALLOWED_DIRS.join(", "),
        );
      }
      return {
        attachment: await importStoredAttachment(target, source.filePath, title),
        sourceMode: "path",
      };
    default:
      return assertNever(source);
  }
}

// Where an /attach request places its file: under the item it names, or standalone.
type AttachPlacement = { kind: "child"; itemKey: string } | { kind: "standalone" };

// An absent item_key asks for a standalone attachment; a present one must name an item.
function attachPlacement(itemKey: unknown): AttachPlacement {
  if (itemKey === undefined) {
    return { kind: "standalone" };
  }
  return { kind: "child", itemKey: requireNonEmptyString(itemKey, "item_key") };
}

// The target a placement stores into, and the response fields that report where it landed.
type PlacedAttachment = {
  target: AttachTarget;
  details: { parent_item_key: string | null; collection_key: string | null };
  message: string;
};

async function placeAttachment(placement: AttachPlacement): Promise<PlacedAttachment> {
  switch (placement.kind) {
    case "child":
      await getUserItemOrThrow(placement.itemKey);
      return {
        target: { kind: "child", parentItemKey: placement.itemKey },
        details: { parent_item_key: placement.itemKey, collection_key: null },
        message: "File attached successfully to item " + placement.itemKey,
      };
    case "standalone":
      return placeStandalone();
    default:
      return assertNever(placement);
  }
}

// A standalone attachment lands in the collection selected in Zotero, or in the library root.
function placeStandalone(): PlacedAttachment {
  let collection = selectedCollection();
  return {
    target: { kind: "standalone", collections: collection === undefined ? [] : [collection.id] },
    details: {
      parent_item_key: null,
      collection_key: collection === undefined ? null : collection.key,
    },
    message: "File stored as a standalone attachment",
  };
}

async function handleFulltextAttach(data: RequestData) {
  let placement = attachPlacement(data.item_key);
  let title = requireNonEmptyString(data.title, "title");
  let filePath = optionalNonEmptyString(data.file_path);
  let fileName = optionalNonEmptyString(data.file_name);
  let fileBytesBase64 = optionalNonEmptyString(data.file_bytes_base64);

  let source = attachSource(filePath, fileName, fileBytesBase64);
  let placed = await placeAttachment(placement);
  let { attachment, sourceMode } = await storeAttachmentFile(placed.target, title, source);

  return successResult(
    "attach_file_to_item",
    { ...placed.details, file_path: filePath, source_mode: sourceMode, title: title },
    {
      attachment_key: attachment.key,
      attachment_id: attachment.id,
      message: placed.message,
      handler: "fulltext-attach",
    },
  );
}

export async function handleAttachRequest(data: unknown): Promise<EndpointResult> {
  try {
    log("Received POST request to " + FULLTEXT_ATTACH_PATH + " [v" + PLUGIN_VERSION + "]");
    return jsonResult(200, await handleFulltextAttach(requireRequestObject(data)));
  } catch (error) {
    let msg = (error as Error).message;
    let status = isApiError(error) ? error.status : 500;
    log("Error in " + FULLTEXT_ATTACH_PATH + " [v" + PLUGIN_VERSION + "]: " + msg);
    return jsonResult(
      status,
      errorResult("attach_file_to_item", "attach_endpoint", msg, {
        request: data,
      }),
    );
  }
}
