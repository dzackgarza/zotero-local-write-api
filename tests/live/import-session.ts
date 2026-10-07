/**
 * The shared setup and cleanup of the live import suites.
 *
 * Each suite opens its own session: its own fixture server, scratch collection
 * and record of created items, so suites run in one `bun test` invocation do
 * not share state. Creating the scratch collection in `beforeAll` is the first
 * request to Zotero, so an unreachable Zotero fails the suite there. Every item
 * the add-on reports as newly created is trashed in `afterAll`, together with
 * the scratch collection. Items reported as already present are never touched,
 * because they are the library's own.
 */
import { afterAll, beforeAll } from "bun:test";

import { createZoteroLocalWriteClient } from "../../src/client";
import type { components } from "../../src/generated/openapi";
import { FixtureServer } from "./fixture-server";
import { liveSetting } from "./settings";

type ImportOptions = Omit<components["schemas"]["ImportFromUrlRequest"], "operation" | "url">;

export const client = createZoteroLocalWriteClient(liveSetting("ZOTERO_LOCAL_BASE_URL"));

class ImportSession {
  readonly uid = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  readonly server = new FixtureServer();
  private readonly createdItemKeys: string[] = [];
  private scratchCollection = "";

  /** The key of the scratch collection; set once `beforeAll` has run. */
  get collectionKey(): string {
    return this.scratchCollection;
  }

  /** Record items the suite created, so `afterAll` trashes them. */
  track(itemKeys: string[]): void {
    this.createdItemKeys.push(...itemKeys);
  }

  async importFromUrl(url: string, options: ImportOptions = {}) {
    const { data, error } = await client.POST("/write", {
      body: { operation: "import_from_url", url, ...options },
    });
    if (error !== undefined) {
      throw new Error(`import_from_url ${url} failed: ${error.stage}: ${error.error}`);
    }
    if (data === undefined || data.operation !== "import_from_url") {
      throw new Error(`import_from_url ${url} returned no import_from_url success`);
    }
    if (!data.existing) {
      this.track([data.item_key]);
    }
    return data;
  }

  async open(): Promise<void> {
    const { data, error } = await client.POST("/write", {
      body: { operation: "create_collection", name: `lw-import-url-${this.uid}` },
    });
    if (error !== undefined || data === undefined || data.operation !== "create_collection") {
      throw new Error("scratch collection could not be created");
    }
    this.scratchCollection = data.details.collection_key;
  }

  async close(): Promise<void> {
    this.server.stop();
    for (const itemKey of this.createdItemKeys) {
      await trash({ operation: "trash_item", item_key: itemKey }, itemKey);
    }
    if (this.scratchCollection !== "") {
      const collectionKey = this.scratchCollection;
      await trash({ operation: "trash_collection", collection_key: collectionKey }, collectionKey);
    }
  }
}

type TrashRequest =
  | components["schemas"]["TrashItemRequest"]
  | components["schemas"]["TrashCollectionRequest"];

async function trash(body: TrashRequest, key: string): Promise<void> {
  const { error } = await client.POST("/write", { body });
  if (error !== undefined) {
    throw new Error(`cleanup of ${key} failed: ${error.error}`);
  }
}

/** Open a session for the calling suite, with its `beforeAll` and `afterAll`. */
export function openImportSession(): ImportSession {
  const session = new ImportSession();
  beforeAll(() => session.open());
  afterAll(() => session.close());
  return session;
}
