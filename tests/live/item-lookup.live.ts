/**
 * Live proof of the lookup operations: `find_items_by_title` finds an item by its
 * title, and `get_item_children` answers where Zotero stores each attachment file.
 *
 * The claim under test is a fact about the running Zotero's file system, so the
 * proof stores a real PDF child through `/attach` and checks the answered path on
 * this machine's disk.
 *
 * MUTATING: the suite creates a book with a PDF child. The file name has no `.test`
 * part, so `bun test` does not collect it; `just item-lookup-live` runs it by path.
 * The book is trashed in `afterAll`, which also trashes its child.
 */
import { afterAll, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { createZoteroLocalWriteClient } from "../../src/client";
import { liveSetting } from "./settings";

const client = createZoteroLocalWriteClient(liveSetting("ZOTERO_LOCAL_BASE_URL"));

const uid = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const createdItemKeys: string[] = [];

// The smallest file Zotero stores as a PDF; its bytes are irrelevant to the lookup.
const PDF_BYTES = "%PDF-1.4\n%item-lookup-proof\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n";

async function createBook(title: string): Promise<string> {
  const { data, error } = await client.POST("/write", {
    body: { operation: "create_item", item_type: "book", fields: { title } },
  });
  if (error !== undefined || data?.operation !== "create_item") {
    throw new Error(`create_item failed: ${JSON.stringify(error)}`);
  }
  createdItemKeys.push(data.item_key);
  return data.item_key;
}

async function attachPdf(itemKey: string): Promise<string> {
  const { data, error } = await client.POST("/attach", {
    body: {
      item_key: itemKey,
      title: `lw-lookup-pdf-${uid}`,
      file_name: "lookup.pdf",
      file_bytes_base64: Buffer.from(PDF_BYTES).toString("base64"),
    },
  });
  if (error !== undefined || data === undefined) {
    throw new Error(`/attach under ${itemKey} failed: ${JSON.stringify(error)}`);
  }
  return data.attachment_key;
}

afterAll(async () => {
  for (const itemKey of createdItemKeys) {
    const { error } = await client.POST("/write", {
      body: { operation: "trash_item", item_key: itemKey },
    });
    expect(error).toBeUndefined();
  }
});

test("get_item_children answers a stored PDF child with its absolute path on disk", async () => {
  const itemKey = await createBook(`lw-lookup-children-${uid}`);
  const attachmentKey = await attachPdf(itemKey);

  const { data, error } = await client.POST("/write", {
    body: { operation: "get_item_children", item_key: itemKey },
  });
  expect(error).toBeUndefined();
  if (data?.operation !== "get_item_children") {
    throw new Error(`get_item_children returned no get_item_children success`);
  }
  expect(data.details.parent_item_key).toBe(itemKey);
  const pdf = data.details.children.find((child) => child.item_key === attachmentKey);
  if (pdf?.child_type !== "attachment") {
    throw new Error(`the PDF ${attachmentKey} is not an attachment child of ${itemKey}`);
  }
  expect(pdf.content_type).toBe("application/pdf");
  if (pdf.local_path === null) {
    throw new Error(`the stored PDF ${attachmentKey} has no local path`);
  }
  expect(isAbsolute(pdf.local_path)).toBe(true);
  expect((await stat(pdf.local_path)).size).toBe(Buffer.byteLength(PDF_BYTES));
});

test("find_items_by_title answers the item whose title contains the query", async () => {
  const title = `lw-lookup-title-${uid}`;
  const itemKey = await createBook(title);

  const { data, error } = await client.POST("/write", {
    body: { operation: "find_items_by_title", title: `lookup-title-${uid}` },
  });
  expect(error).toBeUndefined();
  if (data?.operation !== "find_items_by_title") {
    throw new Error(`find_items_by_title returned no find_items_by_title success`);
  }
  expect(data.details.match_count).toBe(1);
  expect(data.details.items).toEqual([
    expect.objectContaining({ item_key: itemKey, item_type: "book", title }),
  ]);
});
