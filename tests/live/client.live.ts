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
import assert from "node:assert/strict";

import { afterAll, expect, test } from "bun:test";

import { createZoteroLocalWriteClient } from "../../src/client";
import { liveSetting } from "./settings";

const BASE_URL = liveSetting("ZOTERO_LOCAL_BASE_URL");
const LIBRARY_ID = liveSetting("ZOTERO_LIBRARY_ID");

// Zotero's object-key alphabet and length: `Zotero.Utilities.allowedKeyChars`
// and `generateObjectKey` (typed in zotero-types' xpcom/utilities).
const ZOTERO_KEY = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/;

const client = createZoteroLocalWriteClient(BASE_URL);

const uid = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const createdItemKeys: string[] = [];

/** Read an item back through Zotero's built-in read-only local API. */
async function readItem(itemKey: string): Promise<{ data: Record<string, unknown> }> {
  const url = `${BASE_URL}/api/users/${LIBRARY_ID}/items/${encodeURIComponent(itemKey)}`;
  const response = await fetch(url);
  assert(response.ok, `read-back of ${itemKey} failed: GET ${url} returned HTTP ${response.status}`);
  // Parsed from text rather than response.json(): zotero-types shadows the
  // global JSON type, so response.json() resolves to that shadowed type instead
  // of something assignable here.
  return JSON.parse(await response.text());
}

/**
 * Create a tagged book through the wrapper and return its `create_item`
 * success. Asserting on the `operation` discriminator is the typed split:
 * `item_key` does not exist on the WriteSuccessResponse union until then.
 */
async function createBook(title: string) {
  const body = {
    operation: "create_item" as const,
    item_type: "book",
    fields: { title },
    tags: [`lw-tag-${uid}`],
  };
  const { data, error } = await client.POST("/write", { body });
  assert(
    error === undefined && data !== undefined,
    `create_item via the wrapper failed; request=${JSON.stringify(body)}; error=${JSON.stringify(error)}`,
  );
  assert(
    data.operation === "create_item",
    `create_item returned another operation's success; response=${JSON.stringify(data)}`,
  );
  createdItemKeys.push(data.item_key);
  return data;
}

afterAll(async () => {
  for (const itemKey of createdItemKeys) {
    const { error } = await client.POST("/write", {
      body: { operation: "trash_item", item_key: itemKey },
    });
    // A cleanup failure means Zotero is genuinely broken; surface it rather
    // than leaving the operator to discover the residue later.
    assert(error === undefined, `cleanup of ${itemKey} failed: ${JSON.stringify(error)}`);
  }
});

test("wrapper POSTs /write and returns the typed success branch", async () => {
  const title = `lw-client-${uid}`;

  const created = await createBook(title);

  expect(created.success).toBe(true);
  expect(created.item_key).toMatch(ZOTERO_KEY);
  expect(created.item_id).toBeTypeOf("number");
  expect(created.details?.item_type).toBe("book");

  // The write response claiming success is not the proof; the read-back is.
  const readBack = await readItem(created.item_key);
  expect(readBack.data.key).toBe(created.item_key);
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
  assert(error !== undefined, "add_item_tags on a missing item returned no error branch");
  expect(error.success).toBe(false);
  expect(error.operation).toBe("add_item_tags");
  expect(error.error).toContain("Item not found");
  expect(error.details.request).toEqual(body);
});
