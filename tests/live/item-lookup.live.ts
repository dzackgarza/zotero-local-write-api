/**
 * Live proof of the lookup operations: `find_items_by_title` finds an item by its
 * title, and `get_item_children` answers the state of each attachment's file.
 *
 * The file state is a fact about the running Zotero's file system, so the proof
 * stores real PDF children through `/attach`, links a URL child through
 * `attach_url`, and checks the answers against this machine's disk.
 *
 * MUTATING: the suite creates books with attachment children. The file name has no
 * `.test` part, so `bun test` does not collect it; `just item-lookup-live` runs it by
 * path. `openImportSession` owns the cleanup: it trashes each book, and with it the
 * book's children.
 */
import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { stat, unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { client, openImportSession } from "./import-session";

const session = openImportSession();

// The smallest file Zotero stores as a PDF; its bytes are irrelevant to the lookup.
const PDF_BYTES = "%PDF-1.4\n%item-lookup-proof\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n";

async function createBook(title: string): Promise<string> {
  const { data, error } = await client.POST("/write", {
    body: { operation: "create_item", item_type: "book", fields: { title } },
  });
  assert(error === undefined, `create_item ${title} failed: ${JSON.stringify(error)}`);
  assert(
    data?.operation === "create_item",
    `create_item ${title} answered ${JSON.stringify(data)}`,
  );
  session.track([data.item_key]);
  return data.item_key;
}

async function attachPdf(itemKey: string): Promise<string> {
  const { data, error } = await client.POST("/attach", {
    body: {
      item_key: itemKey,
      title: `lw-lookup-pdf-${session.uid}`,
      file_name: "lookup.pdf",
      file_bytes_base64: Buffer.from(PDF_BYTES).toString("base64"),
    },
  });
  assert(error === undefined, `/attach under ${itemKey} failed: ${JSON.stringify(error)}`);
  assert(data !== undefined, `/attach under ${itemKey} answered no body`);
  return data.attachment_key;
}

async function attachUrl(itemKey: string): Promise<string> {
  const url = `https://example.org/lw-lookup-${session.uid}`;
  const { data, error } = await client.POST("/write", {
    body: { operation: "attach_url", parent_item_key: itemKey, url },
  });
  assert(error === undefined, `attach_url under ${itemKey} failed: ${JSON.stringify(error)}`);
  assert(data?.operation === "attach_url", `attach_url answered ${JSON.stringify(data)}`);
  return data.attachment_key;
}

/** The file state get_item_children answers for the attachment child `attachmentKey`. */
async function childFile(itemKey: string, attachmentKey: string) {
  const { data, error } = await client.POST("/write", {
    body: { operation: "get_item_children", item_key: itemKey },
  });
  assert(error === undefined, `get_item_children ${itemKey} failed: ${JSON.stringify(error)}`);
  assert(
    data?.operation === "get_item_children",
    `get_item_children answered ${JSON.stringify(data)}`,
  );
  expect(data.details.parent_item_key).toBe(itemKey);
  const child = data.details.children.find((candidate) => candidate.item_key === attachmentKey);
  assert(
    child?.child_type === "attachment",
    `${attachmentKey} is not an attachment child of ${itemKey}: ${JSON.stringify(data.details.children)}`,
  );
  return child.file;
}

test("get_item_children answers a stored PDF as on disk, with its absolute path", async () => {
  const itemKey = await createBook(`lw-lookup-stored-${session.uid}`);
  const attachmentKey = await attachPdf(itemKey);

  const file = await childFile(itemKey, attachmentKey);

  assert(
    file.state === "on_disk",
    `the stored PDF ${attachmentKey} answered ${JSON.stringify(file)}`,
  );
  expect(isAbsolute(file.path)).toBe(true);
  expect((await stat(file.path)).size).toBe(Buffer.byteLength(PDF_BYTES));
});

test("get_item_children answers a stored PDF whose file left the disk as missing", async () => {
  const itemKey = await createBook(`lw-lookup-missing-${session.uid}`);
  const attachmentKey = await attachPdf(itemKey);
  const stored = await childFile(itemKey, attachmentKey);
  assert(
    stored.state === "on_disk",
    `the stored PDF ${attachmentKey} answered ${JSON.stringify(stored)}`,
  );

  await unlink(stored.path);

  expect(await childFile(itemKey, attachmentKey)).toEqual({ state: "missing" });
});

test("get_item_children answers a linked URL as a link that has no file", async () => {
  const itemKey = await createBook(`lw-lookup-link-${session.uid}`);
  const attachmentKey = await attachUrl(itemKey);

  expect(await childFile(itemKey, attachmentKey)).toEqual({ state: "linked_url" });
});

test("find_items_by_title answers the item whose title contains the query", async () => {
  const title = `lw-lookup-title-${session.uid}`;
  const itemKey = await createBook(title);

  const { data, error } = await client.POST("/write", {
    body: { operation: "find_items_by_title", title: `lookup-title-${session.uid}` },
  });

  assert(error === undefined, `find_items_by_title failed: ${JSON.stringify(error)}`);
  assert(
    data?.operation === "find_items_by_title",
    `find_items_by_title answered ${JSON.stringify(data)}`,
  );
  expect(data.details.match_count).toBe(1);
  expect(data.details.items).toMatchObject([{ item_key: itemKey, item_type: "book", title }]);
});
