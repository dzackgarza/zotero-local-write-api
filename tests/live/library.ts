/** Read-back of the library through Zotero's built-in read-only local API. */
import { expect } from "bun:test";

import { liveSetting } from "./settings";

export type ItemData = {
  itemType: string;
  title: string;
  DOI?: string;
  date?: string;
  url?: string;
  citationKey: string;
  creators: { creatorType?: string; firstName?: string; lastName?: string }[];
  collections: string[];
  tags: { tag: string }[];
  deleted?: boolean;
};

type ChildData = { itemType: string; contentType?: string; linkMode?: string };

/** A URL under the library in Zotero's built-in read-only local API. */
function libraryUrl(path: string): string {
  const base = liveSetting("ZOTERO_LOCAL_BASE_URL");
  return `${base}/api/users/${liveSetting("ZOTERO_LIBRARY_ID")}/${path}`;
}

/** The parsed JSON body of a read-only local API request. */
async function readLibrary<T>(path: string, what: string): Promise<T> {
  const response = await fetch(libraryUrl(path));
  if (!response.ok) {
    throw new Error(`${what} failed: HTTP ${response.status}`);
  }
  // Parsed from text: zotero-types shadows the global JSON type for response.json().
  return JSON.parse(await response.text());
}

export async function readItem(itemKey: string): Promise<ItemData> {
  const path = `items/${encodeURIComponent(itemKey)}`;
  return (await readLibrary<{ data: ItemData }>(path, `read-back of ${itemKey}`)).data;
}

/** The keys of an item's children: attachments and notes. */
export async function childKeys(itemKey: string): Promise<string[]> {
  const path = `items/${encodeURIComponent(itemKey)}/children`;
  const children = await readLibrary<{ key: string }[]>(path, `children of ${itemKey}`);
  return children.map((child) => child.key).sort();
}

/** The attachments under an item, stored files and links alike. */
export async function attachmentChildren(itemKey: string): Promise<ChildData[]> {
  const path = `items/${encodeURIComponent(itemKey)}/children`;
  const children = await readLibrary<{ data: ChildData }[]>(path, `children of ${itemKey}`);
  return children.map((child) => child.data).filter((child) => child.itemType === "attachment");
}

/** The files Zotero stores under an item. */
async function storedChildren(itemKey: string): Promise<ChildData[]> {
  return (await attachmentChildren(itemKey)).filter((child) => child.linkMode === "imported_url");
}

export async function expectStoredPdf(itemKey: string): Promise<void> {
  const contentTypes = (await storedChildren(itemKey)).map((child) => child.contentType);
  expect(contentTypes).toContain("application/pdf");
}

/** The number of top-level items the library holds. */
export async function libraryItemCount(): Promise<number> {
  const response = await fetch(libraryUrl("items/top?limit=1"));
  if (!response.ok) {
    throw new Error(`item count failed: HTTP ${response.status}`);
  }
  return Number(response.headers.get("Total-Results"));
}
