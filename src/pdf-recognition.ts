import { Mutex } from "async-mutex";
import {
  type DuplicateKeys,
  duplicateKeysFromItem,
  fileExistingItem,
  findExistingItem,
} from "./duplicates";
import { userLibraryID } from "./library";
import {
  answered,
  type DownloadedPdf,
  type ImportOutcome,
  type MethodResult,
  miss,
  type SaveTarget,
  type ServiceAnswer,
  serviceFailure,
} from "./source-results";
import { getSyncRunner, recognizeDocument } from "./zotero-api";

type RecognizedParent = { parent: Zotero.Item; pdf: Zotero.Item };

// The recognizer saves the parent item it creates, and resolve_url erases that
// parent again. One recognition runs at a time, from the download until its
// caller has kept or erased the parent, and a duplicate lookup outside a
// recognition waits for the running one. So no lookup answers with a parent
// that is about to be erased.
const recognition = new Mutex();

export function withRecognizedParent<T>(
  pdf: DownloadedPdf,
  use: (recognized: RecognizedParent) => Promise<T>,
): Promise<MethodResult<T>> {
  return recognition.runExclusive(() =>
    heldFromSync(async () => {
      let recognized = await recognizeParent(pdf);
      if (recognized.outcome !== "identified") {
        return recognized;
      }
      return { outcome: "identified", found: await use(recognized.found) };
    }),
  );
}

// A recognition stores the PDF and its parent, and its caller can erase both. A
// sync between the save and the erase would upload them, and the erase would then
// conflict with the uploaded copies and open Zotero's merge dialog. So no sync
// reads the library while a recognition runs, as in Zotero's Mendeley import
// (mendeleyImport.mjs, `Zotero.Sync.Runner.delayIndefinite()`). A sync that runs
// already can upload items that are saved after it started, so the hold starts
// only when no sync runs. A sync that starts later waits for the hold before it
// reads data (syncRunner.js `_sync`: `_syncInProgress` is set, then the sync
// waits for `_delayPromises`), and the check and the hold run in one tick.
async function heldFromSync<T>(run: () => Promise<T>): Promise<T> {
  let runner = getSyncRunner();
  if (runner === null) {
    throw new Error("Zotero.Sync.Runner is not available");
  }
  while (runner.syncInProgress) {
    await Zotero.Promise.delay(500);
  }
  let resume = runner.delayIndefinite();
  try {
    return await run();
  } finally {
    resume();
  }
}

export function findExistingOutsideRecognition(keys: DuplicateKeys): Promise<Zotero.Item | null> {
  return recognition.runExclusive(() => findExistingItem(keys, null));
}

// Zotero's "Retrieve Metadata for PDF": the PDF is stored as a standalone
// attachment, and the recognizer creates its parent item from the DOI or ISBN
// in the text, or from Zotero's recognizer service, and moves the PDF under it.
// The recognizer logs its own errors instead of throwing, so a missing parent
// is the only failure signal; the parentless PDF is then erased.
async function recognizeParent(source: DownloadedPdf): Promise<MethodResult<RecognizedParent>> {
  let pdf = await storeSourcePdf(source);
  if (pdf.outcome === "failed") {
    return pdf;
  }
  await recognizeDocument().recognizeItems([pdf.value]);
  let parentID = pdf.value.parentItemID;
  if (parentID === undefined || parentID === false) {
    await pdf.value.eraseTx();
    return miss("no_match", "the recognizer produced no parent item (see the Zotero debug log)");
  }
  let parent = await Zotero.Items.getAsync(parentID);
  if (parent === false) {
    throw new Error("recognized parent item " + parentID + " is missing");
  }
  return { outcome: "identified", found: { parent, pdf: pdf.value } };
}

// The downloaded file is not a PDF (attachments.js `_enforceFileType`); any other error
// propagates.
async function storeSourcePdf(pdf: DownloadedPdf): Promise<ServiceAnswer<Zotero.Item>> {
  try {
    return answered(await storePdf(pdf, null));
  } catch (error) {
    if (!(error instanceof Zotero.Attachments.InvalidPDFException)) {
      throw error;
    }
    return serviceFailure(error.message);
  }
}

// The downloaded PDF is stored as Zotero stores a PDF that it downloads itself
// (attachments.js `importFromURL`, `externalHandlerImport`): the file must be a PDF
// (`_enforceFileType`), it is copied under the URL's file name into a temporary storage
// directory, and that directory becomes the storage directory of an imported-URL
// attachment (`createURLAttachmentFromTemporaryStorageDirectory`).
export async function storePdf(
  pdf: DownloadedPdf,
  parentItemID: number | null,
): Promise<Zotero.Item> {
  await requirePdfFile(pdf.file);
  let filename = Zotero.Attachments._getFileNameFromURL(pdf.finalUrl, "application/pdf");
  let directory = (await Zotero.Attachments.createTemporaryStorageDirectory()).path;
  try {
    await IOUtils.copy(pdf.file, PathUtils.join(directory, filename));
    return await Zotero.Attachments.createURLAttachmentFromTemporaryStorageDirectory({
      directory,
      libraryID: userLibraryID(),
      filename,
      url: pdf.finalUrl,
      contentType: "application/pdf",
      ...(parentItemID === null ? {} : { parentItemID }),
    });
  } catch (error) {
    await IOUtils.remove(directory, { recursive: true, ignoreAbsent: true });
    throw error;
  }
}

// attachments.js `_enforceFileType`: the first 1000 bytes of the file sniff as a PDF.
// Latin-1 maps each byte to one character, as the sniffer's byte signatures expect.
async function requirePdfFile(file: string): Promise<void> {
  let sample = new TextDecoder("latin1").decode(await IOUtils.read(file, { maxBytes: 1000 }));
  if (Zotero.MIME.sniffForMIMEType(sample) !== "application/pdf") {
    throw new Zotero.Attachments.InvalidPDFException();
  }
}

export function hasStoredPdf(item: Zotero.Item): boolean {
  return Zotero.Items.get(item.getAttachments(false)).some(
    (attachment) => attachment.attachmentContentType === "application/pdf",
  );
}

type RecognizedImport = Omit<ImportOutcome, "method"> & { message: string };

export async function recognizePdf(
  pdf: DownloadedPdf,
  target: SaveTarget,
): Promise<MethodResult<RecognizedImport>> {
  return withRecognizedParent(pdf, (recognized) => fileRecognized(recognized, target));
}

// An existing item is the library's own: the recognized copy and its PDF are
// erased, and the existing item only gains the requested collections. A new item keeps
// the PDF only when the target stores attachments.
async function fileRecognized(
  { parent, pdf }: RecognizedParent,
  target: SaveTarget,
): Promise<RecognizedImport> {
  let existing = await findExistingItem(duplicateKeysFromItem(parent), parent.id);
  if (existing) {
    await pdf.eraseTx();
    await parent.eraseTx();
    await fileExistingItem(existing, target.collectionIDs);
    return recognizedImport(existing, true);
  }
  if (!target.storeAttachments) {
    await pdf.eraseTx();
  }
  if (target.collectionIDs.length) {
    parent.setCollections(target.collectionIDs);
    await parent.saveTx();
  }
  return recognizedImport(parent, false);
}

// The recognizer saves no attachment of its own, so it has no attachment failures.
function recognizedImport(item: Zotero.Item, existing: boolean): RecognizedImport {
  let message = item.getField("title");
  return { item, existing, translator: null, attachmentFailures: [], message };
}
