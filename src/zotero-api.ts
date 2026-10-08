import { type JsonPayload } from "./responses";

// Single source of truth for the places where zotero-types under-models fields that
// Zotero accepts at runtime. Each helper owns exactly one runtime-contract widening so
// the rest of the file reads cleanly typed instead of scattering casts.

// Zotero accepts `false` for Collection.parentKey to detach a collection from its
// parent, but zotero-types models the field as `string`. This is the single owned site
// that writes that runtime contract; callers go through it instead of casting.
export function setCollectionParentKey(
  collection: Zotero.Collection,
  parentKey: string | false,
): void {
  (collection as { parentKey: string | false }).parentKey = parentKey;
}

// Tags.js guards `if (onProgress)` and `if (types)`, so both are optional at runtime;
// zotero-types incorrectly marks them required. This is the single owned site that calls
// removeFromLibrary against its real two-argument contract.
export function removeTagsFromUserLibrary(libraryID: number, tagIDs: number[]): Promise<void> {
  let remove = Zotero.Tags.removeFromLibrary as (
    this: typeof Zotero.Tags,
    libraryID: number,
    tagIDs: number[],
  ) => Promise<void>;
  // Call through Zotero.Tags: removeFromLibrary uses `this` internally (it
  // reaches this.getColors), so invoking the extracted reference unbound throws
  // "this.getColors is not a function" at runtime.
  return remove.call(Zotero.Tags, libraryID, tagIDs);
}

// Zotero.Translate.Search and Zotero.Translate.Import are under-modeled.
export type ZoteroTranslateSearchApi = {
  setIdentifier(identifier: Identifier): void;
  getTranslators(): Promise<unknown[]>;
  setTranslator(translators: unknown): void;
  translate(options: {
    libraryID: number;
    collections: number[] | false;
    saveAttachments: boolean;
  }): Promise<Zotero.Item[] | false>;
  // With `libraryID: false` a translation saves nothing and resolves the
  // translator's item JSON instead (translate.js `_prepareTranslation`).
  translate(options: { libraryID: false; saveAttachments: false }): Promise<TranslatorItemJSON[]>;
};
// Item JSON as a Zotero translator emits it (translate.js `_itemDone`). Only the
// fields this add-on reads are named; the rest pass through to the ItemSaver.
export type TranslatorItemJSON = JsonPayload & {
  itemType: string;
  title?: string;
  date?: string;
  url?: string;
  DOI?: string;
  ISBN?: string;
  creators?: { lastName?: string; name?: string }[];
};
// A detected web translator, as Zotero.Translate.Web#getTranslators resolves it.
// itemType is detectWeb's answer: an item type, or "multiple" for a choice of
// items (translate.js `complete`, detect state).
export type WebTranslatorInfo = { translatorID: string; label: string; itemType: string };
type ZoteroTranslateWebApi = {
  setDocument(doc: Document): void;
  getTranslators(): Promise<WebTranslatorInfo[]>;
  setTranslator(translator: WebTranslatorInfo): void;
  translate(options: { libraryID: false; saveAttachments: false }): Promise<TranslatorItemJSON[]>;
};
// Models translation/translate_item.js: the saver the translators themselves
// use to turn item JSON into saved items inside one transaction.
type ZoteroItemSaverApi = {
  saveItems(
    jsonItems: TranslatorItemJSON[],
    // Called with progress `false` and the error when an attachment fails.
    attachmentCallback: (
      attachment: { title?: string; url?: string },
      progress: number | false,
      error?: Error,
    ) => void,
  ): Promise<Zotero.Item[]>;
};
type ZoteroItemSaverConstructor = new (options: {
  libraryID: number;
  collections: number[] | false;
  attachmentMode: number;
}) => ZoteroItemSaverApi;
// zotero-types declares Zotero.Translate as `any`, so it cannot be narrowed by
// declaration merging. This is the named shape every Zotero.Translate use asserts.
// Models zotero/zotero chrome/content/zotero/xpcom/translation/translate.js.
export type ZoteroTranslateApi = {
  Search: new () => ZoteroTranslateSearchApi;
  Import: new () => ImportTranslator;
  Web: new () => ZoteroTranslateWebApi;
  ItemSaver: ZoteroItemSaverConstructor & {
    ATTACHMENT_MODE_IGNORE: number;
    ATTACHMENT_MODE_DOWNLOAD: number;
  };
};
export function createTranslateSearch(): ZoteroTranslateSearchApi {
  let TranslateSearch = (Zotero.Translate as ZoteroTranslateApi).Search;
  return new TranslateSearch();
}

// Zotero.Sync.Runner is under-modeled for the foreground sync call.
type ZoteroSyncRunnerApi = {
  sync(options: { background: boolean }): Promise<unknown>;
};
// zotero-types declares Zotero.Translators as `any`; same reason as ZoteroTranslateApi.
// Models zotero/zotero chrome/content/zotero/xpcom/translation/translators.js: init()
// without options waits for the schema update, then answers the running or finished
// initialization, as quickCopy.js uses it.
export type ZoteroTranslatorsApi = { init(): Promise<void> };

// zotero-types declares Zotero.Sync as `any`; same reason as ZoteroTranslateApi.
// Models zotero/zotero chrome/content/zotero/xpcom/sync/syncRunner.js.
type ZoteroSyncApi = { Runner?: ZoteroSyncRunnerApi } | undefined;
export function getSyncRunner(): ZoteroSyncRunnerApi | null {
  let sync = Zotero.Sync as ZoteroSyncApi;
  let runner = sync && sync.Runner;
  if (!runner || typeof runner.sync !== "function") {
    return null;
  }
  return runner;
}
export type Identifier = Record<string, string>;
type ImportTranslator = {
  setTranslator(translatorId: string): void;
  setString(input: string): void;
  translate(options: {
    libraryID: number;
    collections: number[];
    saveAttachments: boolean;
  }): Promise<unknown>;
  translate(options: { libraryID: false; saveAttachments: false }): Promise<TranslatorItemJSON[]>;
};
export type ActiveZoteroPane = {
  // Undefined when the selected row is not a collection (observed at runtime).
  getSelectedCollection(): Zotero.Collection | undefined;
};

// Zotero.Utilities.extractIdentifiers finds every DOI, ISBN, arXiv ID and PMID in
// free text; zotero-types does not declare it.
export function findIdentifiers(text: string): Identifier[] {
  let utilities = Zotero.Utilities as typeof Zotero.Utilities & {
    extractIdentifiers(identifier: string): Identifier[];
  };
  return utilities.extractIdentifiers(text);
}

export function createImportTranslator(): ImportTranslator {
  let translateApi = Zotero.Translate as ZoteroTranslateApi;
  return new translateApi.Import();
}

// zotero-types declares Zotero.ItemFields as `any`.
// Models zotero/zotero chrome/content/zotero/xpcom/data/itemFields.js.
export type ItemFieldsApi = { getID(field: string): number | false };
// zotero-types does not declare Zotero.RecognizeDocument.
// Models zotero/zotero chrome/content/zotero/xpcom/recognizeDocument.js.
type RecognizeDocumentApi = {
  recognizeItems(items: Zotero.Item[]): Promise<void>;
};
export function recognizeDocument(): RecognizeDocumentApi {
  return (Zotero as typeof Zotero & { RecognizeDocument: RecognizeDocumentApi }).RecognizeDocument;
}

// zotero-types omits the Zotero.HTTP exception constructors. Models zotero/zotero
// chrome/content/zotero/xpcom/http.js: request() rejects with one of these when the source
// answers with a failure status, cannot be reached, times out, or fails a certificate check.
type ZoteroHttpFailureApi = {
  UnexpectedStatusException: new (...args: never[]) => Error;
  BrowserOfflineException: new (...args: never[]) => Error;
  TimeoutException: new (...args: never[]) => Error;
  SecurityException: new (...args: never[]) => Error;
};
export function isHttpFailure(error: unknown): error is Error {
  let http = Zotero.HTTP as typeof Zotero.HTTP & ZoteroHttpFailureApi;
  return (
    error instanceof http.UnexpectedStatusException ||
    error instanceof http.BrowserOfflineException ||
    error instanceof http.TimeoutException ||
    error instanceof http.SecurityException
  );
}

export function createTranslateWeb(page: Document): ZoteroTranslateWebApi {
  let translateApi = Zotero.Translate as ZoteroTranslateApi;
  let translate = new translateApi.Web();
  translate.setDocument(page);
  return translate;
}
