import { Mutex } from "async-mutex";
import { userLibraryID } from "./library";
import { recognizeAttachment } from "./pdf-recognizer";
import {
  answered,
  type DownloadedPdf,
  type Identification,
  type MethodResult,
  type ServiceAnswer,
  serviceFailure,
} from "./source-results";
import { attachmentRenaming, getSyncRunner, renamableAttachment } from "./zotero-api";

// What recognition found: the work, not yet saved, and the stored PDF it was read from.
type RecognizedPdf = { identification: Identification; attachment: Zotero.Item };

// One recognition runs at a time, from storing its PDF until its caller has filed
// the work, so a second import of the same PDF finds the first one's item.
const recognition = new Mutex();

// The key of the PDF that a recognition holds. A Zotero that stops while a recognition
// runs never erases that PDF, so the next start erases it (eraseAbandonedPdf).
const HELD_PDF_PREF = "extensions.zotero.localWriteAPI.recognitionPdf";

// Zotero's recognizer reads the text of a stored attachment, so the PDF is stored as a
// standalone attachment while recognition runs. `use` files the work, and can move the
// attachment under the work's item (adoptPdf); an attachment it leaves standalone is
// erased.
export function withRecognizedPdf<T>(
  pdf: DownloadedPdf,
  use: (recognized: RecognizedPdf) => Promise<T>,
): Promise<MethodResult<T>> {
  return recognition.runExclusive(() =>
    heldFromSync(async () => {
      let stored = await storeSourcePdf(pdf);
      if (stored.outcome === "failed") {
        return stored;
      }
      let attachment = stored.value;
      Zotero.Prefs.set(HELD_PDF_PREF, attachment.key, true);
      try {
        let work = await recognizeAttachment(attachment);
        if (work.outcome !== "identified") {
          return work;
        }
        let identification = { json: work.found, translator: null, message: workTitle(work.found) };
        return { outcome: "identified", found: await use({ identification, attachment }) };
      } finally {
        await eraseIfStandalone(attachment);
        Zotero.Prefs.clear(HELD_PDF_PREF, true);
      }
    }),
  );
}

async function eraseIfStandalone(attachment: Zotero.Item): Promise<void> {
  if (attachment.isTopLevelItem()) {
    await attachment.eraseTx();
  }
}

// Erases the PDF that a recognition held when Zotero stopped, unless the recognition had
// moved it under an item. Recognitions that start meanwhile wait for it.
export function eraseAbandonedPdf(): Promise<void> {
  return recognition.runExclusive(() =>
    heldFromSync(async () => {
      let key = Zotero.Prefs.get(HELD_PDF_PREF, true);
      if (typeof key !== "string" || key === "") {
        return;
      }
      let attachment = Zotero.Items.getByLibraryAndKey(userLibraryID(), key);
      if (attachment !== false) {
        await eraseIfStandalone(attachment);
      }
      Zotero.Prefs.clear(HELD_PDF_PREF, true);
    }),
  );
}

function workTitle(json: Identification["json"]): string {
  if (json.title === undefined) {
    throw new Error("the recognized work has no title");
  }
  return json.title;
}

// recognizeDocument.js `_processItem`: the PDF becomes the child of the recognized work's
// item, and its file is renamed after that item where the user's settings rename files.
export async function adoptPdf(attachment: Zotero.Item, parent: Zotero.Item): Promise<void> {
  let originalTitle = attachment.getField("title");
  attachment.parentID = parent.id;
  await attachment.saveTx();
  let renaming = attachmentRenaming();
  if (!renaming.shouldAutoRenameAttachment(attachment)) {
    return;
  }
  let fileBaseName = renaming.getFileBaseNameFromItem(parent, { attachmentTitle: originalTitle });
  let extension = renaming.getCorrectFileExtension(attachment);
  let newName = fileBaseName + (extension ? "." + extension : "");
  let renamable = renamableAttachment(attachment);
  let result = await renamable.renameAttachmentFile(newName, { overwrite: false, unique: true });
  if (result !== true) {
    throw new Error("renaming the PDF to " + newName + " failed: " + String(result));
  }
  renamable.setAutoAttachmentTitle();
  await attachment.saveTx();
}

// The stored PDF is temporary until its caller files it. A
// sync between the save and the erase would upload it, and the erase would then
// conflict with the uploaded copy and open Zotero's merge dialog. So no sync
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
