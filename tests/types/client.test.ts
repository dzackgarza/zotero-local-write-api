// Compile-only type assertions for the generated OpenAPI client.
// These are never executed; they exist so `tsc --noEmit` catches type drift.

import type { paths, components } from "../../src/generated/openapi";

// ── Valid request bodies compile ──────────────────────────────

type WriteRequestBody =
  paths["/write"]["post"]["requestBody"]["content"]["application/json"];

// create_item
const createItem: WriteRequestBody = {
  operation: "create_item",
  item_type: "book",
  fields: { title: "Test Book" },
  tags: ["to-read"],
  collection_keys: ["ABC123"],
};

// attach_note
const attachNote: WriteRequestBody = {
  operation: "attach_note",
  parent_item_key: "ABC123",
  note_text: "This is a note.",
  title: "My Note",
};

// merge_items
const mergeItems: WriteRequestBody = {
  operation: "merge_items",
  source_key: "ABC123",
  target_key: "DEF456",
};

// ── Missing required fields do not compile ────────────────────

// @ts-expect-error create_item requires item_type — Property 'item_type' is missing
const missingItemType: WriteRequestBody = {
  operation: "create_item",
};

// @ts-expect-error attach_note requires parent_item_key — Property 'parent_item_key' is missing
const missingParentKey: WriteRequestBody = {
  operation: "attach_note",
  note_text: "note",
};

// @ts-expect-error merge_items requires source_key and target_key — missing both
const missingMergeKeys: WriteRequestBody = {
  operation: "merge_items",
};

// ── Unknown operation does not compile ────────────────────────

const unknownOp: WriteRequestBody = {
  // @ts-expect-error unknown_operation is not a valid operation literal
  operation: "unknown_operation",
  item_key: "ABC123",
};

// ── After narrowing, operation-specific fields are available ──
// openapi-typescript flattens allOf into intersection types, so fields
// are accessed directly on the schema type, not via allOf[1].

type CreateItemSuccess = components["schemas"]["CreateItemSuccess"];

// details should have item_type, field_names, tag_count, collection_count
const createItemDetails: NonNullable<CreateItemSuccess["details"]> = {
  item_type: "book",
  field_names: ["title"],
  tag_count: 1,
  collection_count: 0,
};

// Top-level fields should include item_key and item_id
const createItemTop: Pick<CreateItemSuccess, "item_key" | "item_id"> = {
  item_key: "ABC123",
  item_id: 12345,
};

type AttachNoteSuccess = components["schemas"]["AttachNoteSuccess"];
const attachNoteTop: Pick<AttachNoteSuccess, "note_key" | "note_id"> = {
  note_key: "XYZ789",
  note_id: 67890,
};

// ── /attach accepts path-only, bytes-only, and path+fallback ──

type AttachRequestBody =
  paths["/attach"]["post"]["requestBody"]["content"]["application/json"];

// path only
const pathOnly: AttachRequestBody = {
  item_key: "ABC123",
  title: "paper.pdf",
  file_path: "/tmp/paper.pdf",
};

// bytes only
const bytesOnly: AttachRequestBody = {
  item_key: "ABC123",
  title: "paper.pdf",
  file_name: "paper.pdf",
  file_bytes_base64: "JVBERi0xLjQK",
};

// path + bytes fallback
const pathPlusBytes: AttachRequestBody = {
  item_key: "ABC123",
  title: "paper.pdf",
  file_path: "/tmp/paper.pdf",
  file_name: "paper.pdf",
  file_bytes_base64: "JVBERi0xLjQK",
};

// Export so tsc doesn't tree-shake these
export {
  createItem,
  attachNote,
  mergeItems,
  createItemDetails,
  createItemTop,
  attachNoteTop,
  pathOnly,
  bytesOnly,
  pathPlusBytes,
  // Negative cases: exported so they count as "used". Each is a deliberately
  // invalid body whose ts-expect-error fails the build if the type stops
  // rejecting it.
  missingItemType,
  missingParentKey,
  missingMergeKeys,
  unknownOp,
};
