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

/** The number of attachments the library holds outside any item and outside the trash. */
async function standaloneAttachmentCount(): Promise<number> {
  const response = await fetch(libraryUrl("items/top?itemType=attachment&limit=1"));
  if (!response.ok) {
    throw new Error(`standalone attachment count failed: HTTP ${response.status}`);
  }
  return Number(response.headers.get("Total-Results"));
}

/** The keys of the top-level items outside the trash that carry this title. */
async function entriesTitled(title: string): Promise<string[]> {
  const path = `items/top?q=${encodeURIComponent(title)}&limit=100`;
  const items = await readLibrary<{ key: string; data: ItemData }[]>(path, `items titled ${title}`);
  return items
    .filter((item) => item.data.title === title && item.data.deleted !== true)
    .map((item) => item.key)
    .sort();
}

/** The keys of the PDFs stored under an item. */
async function pdfKeys(itemKey: string): Promise<string[]> {
  const path = `items/${encodeURIComponent(itemKey)}/children`;
  const children = await readLibrary<{ key: string; data: ChildData }[]>(
    path,
    `PDFs of ${itemKey}`,
  );
  return children
    .filter((child) => child.data.contentType === "application/pdf")
    .map((child) => child.key)
    .sort();
}

/** How the library holds the work of one item. */
export type HeldWork = {
  entries: string[];
  children: string[];
  pdfs: string[];
  standaloneAttachments: number;
};

export async function heldWork(itemKey: string): Promise<HeldWork> {
  const { title } = await readItem(itemKey);
  return {
    entries: await entriesTitled(title),
    children: await childKeys(itemKey),
    pdfs: await pdfKeys(itemKey),
    standaloneAttachments: await standaloneAttachmentCount(),
  };
}

/** The library holds the work as one entry, this item, with one PDF. */
export function expectOneEntryWithOnePdf(held: HeldWork, itemKey: string): void {
  expect(held.entries).toEqual([itemKey]);
  expect(held.pdfs).toHaveLength(1);
}
