import {
  handleAddItemToCollection,
  handleCreateCollection,
  handleGetSelectedCollection,
  handleMergeCollections,
  handleMoveCollection,
  handleRemoveItemFromCollection,
  handleRenameCollection,
  handleSetItemCollections,
  handleTrashCollection,
} from "./collections";
import { badRequest, isApiError } from "./errors";
import { handleImportBibTeX, handleImportByIdentifier } from "./identifier-import";
import { handleImportFromUrl } from "./import-from-url";
import { handleCopyItem, handleMergeItems } from "./item-copy-merge";
import {
  handleAttachNote,
  handleAttachURL,
  handleCreateItem,
  handleFindItemsByTitle,
  handleGetItemChildren,
  handleRelinkAttachmentFile,
  handleReplaceItemJSON,
  handleRestoreItem,
  handleTrashItem,
  handleUpdateAttachmentTitle,
  handleUpdateItemFields,
  handleUpdateNote,
} from "./items";
import { requireNonEmptyString, requireRequestObject } from "./request-fields";
import { handleResolveUrl } from "./resolve-url";
import {
  type EndpointResult,
  errorResult,
  type JsonPayload,
  jsonResult,
  log,
  type RequestData,
  successResult,
} from "./responses";
import { SOURCE_REMEDIATION, SourceNotIdentifiedError } from "./source-results";
import {
  handleAddItemTags,
  handleDeleteTag,
  handleDeleteUnusedTags,
  handleMergeTags,
  handleRemoveItemTags,
  handleRenameTag,
  handleSetItemTags,
} from "./tags";
import { getSyncRunner } from "./zotero-api";

async function handleSync(data: RequestData) {
  void data;
  let runner = getSyncRunner();
  if (!runner) {
    throw new Error("Zotero.Sync.Runner.sync is unavailable");
  }
  // Foreground sync so the call resolves once the sync engine has run.
  let result = await runner.sync({ background: false });
  return successResult("sync", { triggered: true, completed: result !== false });
}

async function handleRunJavascript(data: RequestData) {
  // Debug endpoint: evaluate arbitrary internal JavaScript in the add-on's privileged
  // chrome scope, with `Zotero` in scope and `await` supported. Single-user dev tool.
  let code = requireNonEmptyString(data.code, "code");
  type AsyncFunctionConstructor = new (
    ...args: string[]
  ) => (zotero: typeof Zotero) => Promise<unknown>;
  let AsyncFunction = (
    Object.getPrototypeOf(async function () {}) as {
      constructor: AsyncFunctionConstructor;
    }
  ).constructor;
  let fn = new AsyncFunction("Zotero", code);
  let result: unknown = await fn(Zotero);
  let serialized: unknown = JSON.parse(JSON.stringify(result));
  return successResult("run_javascript", { result: serialized });
}

type WriteHandler = (data: RequestData) => JsonPayload | Promise<JsonPayload>;

// One handler per /write operation; openapi.yaml's WriteRequest names the same operations.
let writeHandlers: Record<string, WriteHandler> = {
  sync: handleSync,
  run_javascript: handleRunJavascript,
  update_item_fields: handleUpdateItemFields,
  replace_item_json: handleReplaceItemJSON,
  set_item_tags: handleSetItemTags,
  add_item_tags: handleAddItemTags,
  remove_item_tags: handleRemoveItemTags,
  set_item_collections: handleSetItemCollections,
  add_item_to_collection: handleAddItemToCollection,
  remove_item_from_collection: handleRemoveItemFromCollection,
  attach_note: handleAttachNote,
  update_note: handleUpdateNote,
  attach_url: handleAttachURL,
  trash_item: handleTrashItem,
  trash_collection: handleTrashCollection,
  relink_attachment_file: handleRelinkAttachmentFile,
  create_collection: handleCreateCollection,
  rename_collection: handleRenameCollection,
  move_collection: handleMoveCollection,
  merge_collections: handleMergeCollections,
  rename_tag: handleRenameTag,
  merge_tags: handleMergeTags,
  delete_tag: handleDeleteTag,
  delete_unused_tags: handleDeleteUnusedTags,
  copy_item: handleCopyItem,
  merge_items: handleMergeItems,
  create_item: handleCreateItem,
  import_bibtex: handleImportBibTeX,
  import_by_identifier: handleImportByIdentifier,
  get_selected_collection: handleGetSelectedCollection,
  restore_item: handleRestoreItem,
  update_attachment_title: handleUpdateAttachmentTitle,
  import_from_url: handleImportFromUrl,
  resolve_url: handleResolveUrl,
  find_items_by_title: handleFindItemsByTitle,
  get_item_children: handleGetItemChildren,
};

async function runWrite(data: RequestData) {
  let operation = requireNonEmptyString(data.operation, "operation");
  if (!Object.hasOwn(writeHandlers, operation)) {
    throw badRequest("Unsupported operation: " + operation);
  }
  return writeHandlers[operation](data);
}

// operation may be absent on a malformed request; label it explicitly for
// diagnostics. This is the error-rendering boundary, not a runtime default.
// It is computed inside the try: reading data.operation on a null body
// throws, and doing that outside the try left the error unrendered, which
// hung the request forever instead of answering 400.
export async function handleWriteRequest(data: unknown): Promise<EndpointResult> {
  let operationLabel = "unknown_operation";
  try {
    let body = requireRequestObject(data);
    if (typeof body.operation === "string") {
      operationLabel = body.operation;
    }
    log("Received POST request to " + LOCAL_WRITE_PATH + " [operation=" + operationLabel + "]");
    return jsonResult(200, await runWrite(body));
  } catch (error) {
    return writeError(error as Error, operationLabel, data);
  }
}

// The response for a write that failed: an unidentified source also carries its attempts.
function writeError(error: Error, operationLabel: string, data: unknown): EndpointResult {
  let msg = error.message;
  let status = isApiError(error) ? error.status : 500;
  log("Error in " + LOCAL_WRITE_PATH + " [operation=" + operationLabel + "]: " + msg);
  if (error instanceof SourceNotIdentifiedError) {
    return jsonResult(
      status,
      errorResult(operationLabel, "identify_source", msg, {
        request: data,
        attempts: error.attempts,
        remediation: SOURCE_REMEDIATION,
      }),
    );
  }
  return jsonResult(status, errorResult(operationLabel, "write_endpoint", msg, { request: data }));
}
