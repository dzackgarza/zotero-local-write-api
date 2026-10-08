/**
 * Live proof that the temporary items of PDF recognition never reach the Zotero
 * server. Zotero's recognizer reads a PDF only from an attachment in the library,
 * so `resolve_url`, and `import_from_url` with `store_attachments: false`, store
 * the PDF and erase it again. A sync between the two would upload the PDF, and
 * the erase would then conflict with the uploaded copy and open Zotero's modal
 * merge dialog.
 *
 * Each case starts a sync as soon as a temporary item exists, waits for the
 * operation and the sync, and then asks the Zotero web API whether the server
 * ever held a temporary item: the server lists an uploaded item that is deleted
 * later among the library's deletions, and does not list an item that never
 * left the client.
 *
 * MUTATING, and it syncs the library of the running Zotero with the Zotero
 * server, so that Zotero must be signed in to sync. The file name has no `.test`
 * part, so `bun test` does not collect it; `just import-from-url-live` runs it by
 * path. `openImportSession` owns the setup and the cleanup.
 */
import { expect, test } from "bun:test";

import { client, openImportSession } from "./import-session";

const session = openImportSession();

/** The value that `code` returns inside Zotero. */
async function runJavascript(code: string) {
  const { data, error } = await client.POST("/write", {
    body: { operation: "run_javascript", code },
  });
  if (error !== undefined || data === undefined || data.operation !== "run_javascript") {
    throw new Error(`run_javascript failed: ${error?.error}`);
  }
  return data.details.result;
}

async function zoteroNumber(code: string): Promise<number> {
  const result = await runJavascript(code);
  if (typeof result !== "number") {
    throw new Error(`expected a number from Zotero, got ${JSON.stringify(result)}`);
  }
  return result;
}

async function zoteroStrings(code: string): Promise<string[]> {
  const result = await runJavascript(code);
  if (!Array.isArray(result) || !result.every((value) => typeof value === "string")) {
    throw new Error(`expected a list of strings from Zotero, got ${JSON.stringify(result)}`);
  }
  return result;
}

async function syncLibrary(): Promise<void> {
  const { data, error } = await client.POST("/write", { body: { operation: "sync" } });
  if (error !== undefined || data === undefined || data.operation !== "sync") {
    throw new Error(`sync failed: ${error?.error}`);
  }
  if (!data.details.completed) {
    throw new Error("Zotero cancelled the sync before it ran");
  }
}

/**
 * Runs the operation, records every item the library gains while it runs, and
 * starts a sync as soon as the first one exists. Answers once the operation and
 * the sync are done, with the keys of the recorded items that no longer exist.
 */
async function temporaryKeysWithSyncDuring(operation: () => Promise<void>): Promise<string[]> {
  const lastItemID = await zoteroNumber(
    "return await Zotero.DB.valueQueryAsync('SELECT MAX(itemID) FROM items');",
  );
  const seen = new Set<string>();
  let syncing: Promise<void> | null = null;
  let running = true;
  const done = operation().finally(() => {
    running = false;
  });
  while (running) {
    const added = await zoteroStrings(
      `return await Zotero.DB.columnQueryAsync('SELECT key FROM items WHERE itemID > ${lastItemID}');`,
    );
    for (const key of added) {
      seen.add(key);
    }
    if (syncing === null && seen.size > 0) {
      syncing = syncLibrary();
    }
    await Bun.sleep(200);
  }
  await done;
  if (syncing === null) {
    throw new Error("no item appeared while the operation ran, so no sync ran during it");
  }
  await syncing;
  return zoteroStrings(
    `return ${JSON.stringify([...seen])}.filter((key) => ` +
      "!Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, key));",
  );
}

/**
 * The keys among `keys` that the Zotero server holds or lists as deleted since
 * `version`. It asks the server that Zotero syncs with, as Zotero addresses it.
 */
async function keysTheServerSaw(keys: string[], version: number): Promise<string[]> {
  const [libraryURL, apiKey, apiVersion] = await zoteroStrings(
    "return [Zotero.Sync.Runner.baseURL + 'users/' + Zotero.Users.getCurrentUserID(), " +
      "await Zotero.Sync.Data.Local.getAPIKey(), String(Zotero.Sync.Runner.apiVersion)];",
  );
  const headers = { "Zotero-API-Key": apiKey, "Zotero-API-Version": apiVersion };
  const deleted = await fetch(`${libraryURL}/deleted?since=${version}`, { headers });
  if (!deleted.ok) {
    throw new Error(`Zotero web API deletions: HTTP ${deleted.status}`);
  }
  const deletedItems: string[] = JSON.parse(await deleted.text()).items;
  const seen = keys.filter((key) => deletedItems.includes(key));
  for (const key of keys) {
    const item = await fetch(`${libraryURL}/items/${key}`, { headers });
    if (item.status !== 404) {
      seen.push(key);
    }
  }
  return seen;
}

async function libraryVersion(): Promise<number> {
  return zoteroNumber("return Zotero.Libraries.userLibrary.libraryVersion;");
}

async function mergeDialogOpen(): Promise<boolean> {
  const windows = await zoteroStrings(
    "return Array.from(Services.wm.getEnumerator(null), (window) => window.location.href);",
  );
  return windows.includes("chrome://zotero/content/merge.xhtml");
}

test("resolve_url of a PDF: a sync during recognition uploads no temporary item", async () => {
  const version = await libraryVersion();
  const temporary = await temporaryKeysWithSyncDuring(async () => {
    const { error } = await client.POST("/write", {
      body: { operation: "resolve_url", url: "https://arxiv.org/pdf/1105.0001" },
    });
    expect(error).toBeUndefined();
  });
  expect(temporary.length).toBeGreaterThan(0);
  expect(await mergeDialogOpen()).toBe(false);
  expect(await keysTheServerSaw(temporary, version)).toEqual([]);
});

test("import_from_url of a PDF without attachments: a sync during recognition uploads no temporary item", async () => {
  const version = await libraryVersion();
  const temporary = await temporaryKeysWithSyncDuring(async () => {
    const data = await session.importFromUrl("https://arxiv.org/pdf/1105.0001", {
      store_attachments: false,
    });
    expect(data.existing).toBe(false);
  });
  expect(temporary.length).toBeGreaterThan(0);
  expect(await mergeDialogOpen()).toBe(false);
  expect(await keysTheServerSaw(temporary, version)).toEqual([]);
});
