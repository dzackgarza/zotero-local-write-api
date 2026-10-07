import { duplicateKeysFromItem, fileExistingItem, findExistingItem } from "./duplicates";
import { userLibraryID } from "./library";
import { type ImportOutcome, type MethodResult, type ServiceAnswer, answered, miss, serviceFailure } from "./source-results";
import { isHttpFailure, recognizeDocument } from "./zotero-api";

// Zotero's "Retrieve Metadata for PDF": the PDF is stored as a standalone
// attachment, and the recognizer creates its parent item from the DOI or ISBN
// in the text, or from Zotero's recognizer service, and moves the PDF under it.
// The recognizer logs its own errors instead of throwing, so a missing parent
// is the only failure signal; the parentless PDF is then erased.
export async function recognizeParent(
  finalUrl: string,
): Promise<MethodResult<{ parent: Zotero.Item; pdf: Zotero.Item }>> {
  let pdf = await downloadSourcePdf(finalUrl);
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

// The source's server answers the download with a failure, or with a file that is
// not a PDF (attachments.js `downloadFile`, `_enforceFileType`); any other error propagates.
async function downloadSourcePdf(finalUrl: string): Promise<ServiceAnswer<Zotero.Item>> {
  try {
    return answered(await storePdf(finalUrl, null));
  } catch (error) {
    if (!isHttpFailure(error) && !(error instanceof Zotero.Attachments.InvalidPDFException)) {
      throw error;
    }
    return serviceFailure(error.message);
  }
}

// Zotero downloads the URL and stores the file in the library, as the
// Connector does for a PDF it saves.
export async function storePdf(url: string, parentItemID: number | null): Promise<Zotero.Item> {
  return Zotero.Attachments.importFromURL({
    libraryID: userLibraryID(),
    url,
    contentType: "application/pdf",
    ...(parentItemID === null ? {} : { parentItemID }),
  });
}

export function hasStoredPdf(item: Zotero.Item): boolean {
  return Zotero.Items.get(item.getAttachments(false)).some(
    (attachment) => attachment.attachmentContentType === "application/pdf",
  );
}

type RecognizedImport = Omit<ImportOutcome, "method"> & { message: string };

export async function recognizePdf(
  finalUrl: string,
  collectionIDs: number[],
): Promise<MethodResult<RecognizedImport>> {
  let recognized = await recognizeParent(finalUrl);
  if (recognized.outcome !== "identified") {
    return recognized;
  }
  return { outcome: "identified", found: await fileRecognized(recognized.found, collectionIDs) };
}

// An existing item is the library's own: the recognized copy and its PDF are
// erased, and the existing item only gains the requested collections.
async function fileRecognized(
  { parent, pdf }: { parent: Zotero.Item; pdf: Zotero.Item },
  collectionIDs: number[],
): Promise<RecognizedImport> {
  let existing = await findExistingItem(duplicateKeysFromItem(parent), parent.id);
  if (existing) {
    await pdf.eraseTx();
    await parent.eraseTx();
    await fileExistingItem(existing, collectionIDs);
    return {
      item: existing,
      existing: true,
      translator: null,
      attachmentFailures: [],
      message: existing.getField("title"),
    };
  }
  if (collectionIDs.length) {
    parent.setCollections(collectionIDs);
    await parent.saveTx();
  }
  return {
    item: parent,
    existing: false,
    translator: null,
    attachmentFailures: [],
    message: parent.getField("title"),
  };
}
