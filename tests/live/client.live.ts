/**
 * Live proof of the generated OpenAPI client wrapper (`src/client.ts`).
 *
 * This is the owner of the wrapper's proof burden: that
 * `createZoteroLocalWriteClient` sends a real `POST /write`, serializes the
 * request body unchanged, and returns the typed success/error split. It drives
 * the wrapper against a real running Zotero over real HTTP. There is no mock —
 * a hand-fed mock would prove `openapi-fetch`, not this repo's wrapper.
 *
 * MUTATING: creating an item is a real library write. The file name has no
 * `.test` part, so `bun test` does not collect it; `just client-live` runs it by
 * path. Every object is uniquely prefixed and trashed in `afterAll`, so it is
 * safe against a real library as well as CI's disposable profile.
 *
 * An unreachable Zotero fails every case.
 */
import { afterAll, expect, test } from "bun:test";

import { createZoteroLocalWriteClient } from "../../src/client";

const BASE_URL = process.env.ZOTERO_LOCAL_BASE_URL ?? "http://127.0.0.1:23119";
const LIBRARY_ID = process.env.ZOTERO_LIBRARY_ID ?? "0";

// Passing the env var through undefined when unset also exercises the
// wrapper's own default baseUrl, which is the common local path.
const client = createZoteroLocalWriteClient(process.env.ZOTERO_LOCAL_BASE_URL);

const uid = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const createdItemKeys: string[] = [];

/** Read an item back through Zotero's built-in read-only local API. */
async function readItem(itemKey: string): Promise<{ data: Record<string, unknown> }> {
  const url = `${BASE_URL}/api/users/${LIBRARY_ID}/items/${encodeURIComponent(itemKey)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`read-back of ${itemKey} failed: HTTP ${response.status}`);
  }
  // Parsed from text rather than response.json(): zotero-types shadows the
  // global JSON type, so response.json() resolves to that shadowed type instead
  // of something assignable here.
  return JSON.parse(await response.text());
}

afterAll(async () => {
  for (const itemKey of createdItemKeys) {
    const { error } = await client.POST("/write", {
      body: { operation: "trash_item", item_key: itemKey },
    });
    // A cleanup failure means Zotero is genuinely broken; surface it rather
    // than leaving the operator to discover the residue later.
    if (error !== undefined) {
      throw new Error(`cleanup of ${itemKey} failed: ${error.error}`);
    }
  }
});

test("wrapper POSTs /write and returns the typed success branch", async () => {
  const title = `lw-client-${uid}`;

  const { data, error } = await client.POST("/write", {
    body: {
      operation: "create_item",
      item_type: "book",
      fields: { title },
      tags: [`lw-tag-${uid}`],
    },
  });

  expect(error).toBeUndefined();
  if (data === undefined) {
    throw new Error("success branch returned no data");
  }
  expect(data.success).toBe(true);

  // Narrowing on the discriminator is the typed split: `item_key` does not
  // exist on the WriteSuccessResponse union until `operation` is narrowed.
  if (data.operation !== "create_item") {
    throw new Error(`expected create_item response, got ${data.operation}`);
  }
  const itemKey: string = data.item_key;
  expect(itemKey).toBeTruthy();
  createdItemKeys.push(itemKey);
  expect(data.item_id).toBeTypeOf("number");
  expect(data.details?.item_type).toBe("book");

  // The write response claiming success is not the proof; the read-back is.
  const readBack = await readItem(itemKey);
  expect(readBack.data.title).toBe(title);
  expect(readBack.data.itemType).toBe("book");
});

test("wrapper returns the typed error branch and sends the body unchanged", async () => {
  // A structurally valid body naming an item that cannot exist: the add-on
  // rejects it and echoes the body it parsed back in details.request, which is
  // what proves the wrapper serialized the body without mutating it.
  const body = {
    operation: "add_item_tags" as const,
    item_key: `NOSUCH${uid.slice(0, 4).toUpperCase()}`,
    tags: [`lw-echo-${uid}`, "ünïcodé tag"],
  };

  const { data, error } = await client.POST("/write", { body });

  expect(data).toBeUndefined();
  if (error === undefined) {
    throw new Error("expected the error branch to be populated");
  }
  expect(error.success).toBe(false);
  expect(error.operation).toBe("add_item_tags");
  expect(error.error).toContain("Item not found");
  expect(error.details.request).toEqual(body);
});
