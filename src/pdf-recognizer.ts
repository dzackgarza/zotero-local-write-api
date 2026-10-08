// Zotero's "Retrieve Metadata for PDF", ported so that it saves nothing.
//
// Ported from Zotero, chrome/content/zotero/xpcom/recognizeDocument.js at zotero/zotero
// 85bff00a3cf438a7d2290aa39a35b7ee49d92ecc (tag 8.0.1): `_recognizePDF` (lines 411-578),
// `extractPDFJSON` (338-346), `_query` (372-386) and `_getBaseURL` (773-785). Zotero is
// licensed under the GNU Affero General Public License, version 3; this file is a
// derivative of that code, combined with this GPLv3 add-on under section 13 of both
// licenses.
//
// Each branch of `_recognizePDF` saves the parent item it builds into the PDF's library.
// A duplicate-merge add-on can then merge a library item into that parent before its
// caller decides to keep it. This port answers the parent's item JSON instead: the
// identifier branches translate with `libraryID: false`, through `resolveIdentifier`, and
// the title branch builds the JSON that `_recognizePDF` sets field by field.
import * as v from "valibot";

import { responseTextOf } from "./source-fetch";
import { identifierKey, resolveIdentifier } from "./source-methods";
import {
  answered,
  type MethodResult,
  miss,
  type ServiceAnswer,
  serviceFailure,
} from "./source-results";
import {
  getSyncRunner,
  type Identifier,
  isHttpFailure,
  pdfWorker,
  type RecognizerData,
  type TranslatorItemJSON,
  zoteroServicesUrl,
} from "./zotero-api";

// The recognizer service's answer. The service is Zotero's and has no published schema:
// the fields are those `_recognizePDF` reads. Zotero's setField takes a number or a string
// for each bibliographic number.
let BibliographicNumber = v.union([v.string(), v.number()]);
let RecognizerAnswer = v.object({
  arxiv: v.optional(v.string()),
  doi: v.optional(v.string()),
  isbn: v.optional(v.string()),
  type: v.optional(v.string()),
  title: v.optional(v.string()),
  authors: v.optional(v.array(v.object({ firstName: v.string(), lastName: v.string() }))),
  abstract: v.optional(v.string()),
  year: v.optional(BibliographicNumber),
  pages: v.optional(BibliographicNumber),
  volume: v.optional(BibliographicNumber),
  issue: v.optional(BibliographicNumber),
  url: v.optional(v.string()),
  language: v.optional(v.string()),
  ISSN: v.optional(v.string()),
  container: v.optional(v.string()),
  publisher: v.optional(v.string()),
});
type RecognizerAnswer = v.InferOutput<typeof RecognizerAnswer>;

// The work a stored PDF attachment is, as the item JSON that Zotero's recognizer would
// have saved as its parent.
export async function recognizeAttachment(
  attachment: Zotero.Item,
): Promise<MethodResult<TranslatorItemJSON>> {
  let data = await recognizerData(attachment);
  if (data.outcome === "failed") {
    return miss("no_match", data.message);
  }
  if (!data.value.pages.some((page) => page[2].length > 0)) {
    return miss("no_match", "the PDF has no text layer");
  }
  let answer = await queryRecognizer({ ...data.value, fileName: attachment.attachmentFilename });
  if (answer.outcome === "failed") {
    return answer;
  }
  return workFromAnswer(answer.value);
}

// extractPDFJSON: a PDF that the PDF worker cannot read is one the recognizer cannot
// identify.
async function recognizerData(attachment: Zotero.Item): Promise<ServiceAnswer<RecognizerData>> {
  try {
    return answered(await pdfWorker().getRecognizerData(attachment.id, true));
  } catch (error) {
    return serviceFailure("Zotero could not read the PDF: " + String(error));
  }
}

function recognizerServiceUrl(): string {
  let configured = Zotero.Prefs.get("recognize.url");
  if (typeof configured === "string" && configured !== "") {
    return withTrailingSlash(configured) + "recognize";
  }
  let services = Zotero.Prefs.get("services.url");
  let base = typeof services === "string" && services !== "" ? services : zoteroServicesUrl();
  return withTrailingSlash(base) + "recognizer/recognize";
}

function withTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : url + "/";
}

// _query. A failure status or an unreachable service is the service's answer; any other
// error propagates.
async function queryRecognizer(data: RecognizerData): Promise<ServiceAnswer<RecognizerAnswer>> {
  let runner = getSyncRunner();
  if (runner === null) {
    throw new Error("Zotero.Sync.Runner is not available");
  }
  let url = recognizerServiceUrl();
  let xhr: XMLHttpRequest;
  try {
    xhr = await runner.getAPIClient().makeRequest("POST", url, {
      successCodes: [200],
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      noAPIKey: true,
    });
  } catch (error) {
    if (!isHttpFailure(error)) {
      throw error;
    }
    return serviceFailure(error.message);
  }
  let parsed = v.safeParse(RecognizerAnswer, JSON.parse(responseTextOf(xhr, url)));
  if (!parsed.success) {
    return serviceFailure(url + " answered an unexpected body: " + v.summarize(parsed.issues));
  }
  return answered(parsed.output);
}

// _recognizePDF after the query: the arXiv ID, then the DOI, then the ISBN, each resolved
// by Zotero's search translators; a branch whose translation fails falls through to the
// next. Without an identifier that resolves, the answer's own title and authors are the
// work.
async function workFromAnswer(answer: RecognizerAnswer): Promise<MethodResult<TranslatorItemJSON>> {
  let identifiers: Identifier[] = [];
  if (answer.arxiv !== undefined) {
    identifiers.push({ arXiv: answer.arxiv });
  }
  if (answer.doi !== undefined) {
    identifiers.push({ DOI: answer.doi });
  }
  if (answer.isbn !== undefined) {
    identifiers.push({ ISBN: answer.isbn });
  }
  for (let identifier of identifiers) {
    let item = await resolveIdentifier(identifier);
    if (item.outcome === "identified") {
      return { outcome: "identified", found: withAnswerText(item.found, answer) };
    }
  }
  if (answer.title !== undefined && answer.authors !== undefined) {
    return { outcome: "identified", found: workFromTitle(answer.title, answer.authors, answer) };
  }
  return miss("no_match", noMatchMessage(identifiers));
}

function noMatchMessage(identifiers: Identifier[]): string {
  if (identifiers.length === 0) {
    return "the recognizer service named no work";
  }
  return "no translator resolved " + identifiers.map(identifierKey).join(", ");
}

// The abstract and language the service found, where the translator gave none.
function withAnswerText(json: TranslatorItemJSON, answer: RecognizerAnswer): TranslatorItemJSON {
  return {
    ...json,
    ...(json.abstractNote === undefined && answer.abstract !== undefined
      ? { abstractNote: answer.abstract }
      : {}),
    ...(json.language === undefined && answer.language !== undefined
      ? { language: answer.language }
      : {}),
  };
}

function workFromTitle(
  title: string,
  authors: { firstName: string; lastName: string }[],
  answer: RecognizerAnswer,
): TranslatorItemJSON {
  let itemType = answer.type === "book-chapter" ? "bookSection" : "journalArticle";
  let containerFields =
    itemType === "bookSection"
      ? { bookTitle: answer.container, publisher: answer.publisher }
      : { issue: answer.issue, ISSN: answer.ISSN, publicationTitle: answer.container };
  let fields = {
    abstractNote: answer.abstract,
    date: answer.year,
    pages: answer.pages,
    volume: answer.volume,
    url: answer.url,
    language: answer.language,
    ...containerFields,
  };
  let present = Object.entries(fields).filter(([, value]) => value !== undefined);
  return {
    itemType,
    title,
    creators: authors.map(({ firstName, lastName }) => ({
      firstName,
      lastName,
      creatorType: "author",
    })),
    ...Object.fromEntries(present.map(([field, value]) => [field, String(value)])),
    libraryCatalog: "Zotero",
  };
}
