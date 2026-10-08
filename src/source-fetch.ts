import * as v from "valibot";
import { ApiError, assertNever, badRequest } from "./errors";
import { requireNonEmptyString } from "./request-fields";
import {
  answered,
  type FetchedSource,
  type ServiceAnswer,
  SourceNotIdentifiedError,
  serviceFailure,
} from "./source-results";
import { isHttpFailure, type TranslatorItemJSON } from "./zotero-api";

// An external service's GET. A failure status, an unreachable host, a timeout or a
// certificate failure is the service's answer; any other error propagates.
export async function requestService(
  url: string,
  options: {
    responseType: "text" | "document" | "json";
    successCodes?: number[];
    headers?: Record<string, string>;
  },
): Promise<ServiceAnswer<XMLHttpRequest>> {
  try {
    return answered(await Zotero.HTTP.request("GET", url, options));
  } catch (error) {
    if (!isHttpFailure(error)) {
      throw error;
    }
    return serviceFailure(error.message);
  }
}

// A translation that saves nothing. translate() rejects with the error that ended the
// translation (translate.js `translate`, its "error" handler): the translator, an
// external program, failed.
export async function runTranslation(
  translation: () => Promise<TranslatorItemJSON[]>,
): Promise<ServiceAnswer<TranslatorItemJSON[]>> {
  try {
    return answered(await translation());
  } catch (error) {
    return serviceFailure(String(error));
  }
}

export function requireHttpUrl(value: unknown): string {
  let raw = requireNonEmptyString(value, "url");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw badRequest("url is not a valid URL: " + raw);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw badRequest("url must be an http or https URL: " + raw);
  }
  return parsed.href;
}

// The source is downloaded with Zotero.HTTP.download, as Zotero's own attachment downloads
// are (attachments.js `downloadFile`). Its timeout limits connecting and inactivity, so a
// server that answers at once and streams a large PDF slowly (arXiv, on the first download
// of a new PDF) succeeds; Zotero.HTTP.request limits the whole transfer to 30 s. An HTML page
// is parsed and its meta refresh followed as Zotero.HTTP.request does for a document
// (http.js `_requestInternal`: at most 3 meta redirects; utilities_internal.js
// `blobToHTMLDocument`).
export function fetchSource(url: string): Promise<FetchedSource> {
  return fetchFollowingMetaRefresh(url, 0);
}

async function fetchFollowingMetaRefresh(
  url: string,
  metaRedirects: number,
): Promise<FetchedSource> {
  let path = sourceTempPath();
  try {
    let response = await downloadSource(url, path);
    return await downloadedSource(response, url, path, metaRedirects);
  } finally {
    await IOUtils.remove(path, { ignoreAbsent: true });
  }
}

// The source a download answered, its body read from `path`.
async function downloadedSource(
  response: Response,
  url: string,
  path: string,
  metaRedirects: number,
): Promise<FetchedSource> {
  let finalUrl = finalResponseUrl(response, url);
  let contentType = response.headers.get("Content-Type");
  let body = sourceBody(contentType, finalUrl);
  switch (body) {
    case "pdf":
      return { kind: "pdf", finalUrl };
    case "html":
      return htmlSource(path, finalUrl, metaRedirects);
    case "unidentified":
      throw sourceNotIdentified(contentType);
    default:
      return assertNever(body);
  }
}

function sourceNotIdentified(contentType: string | null): SourceNotIdentifiedError {
  return new SourceNotIdentifiedError(
    "Source is neither an HTML page nor a PDF (Content-Type: " + String(contentType) + ")",
    [],
  );
}

// An HTML page, or the source its meta refresh names while fewer than 3 were followed.
async function htmlSource(
  path: string,
  finalUrl: string,
  metaRedirects: number,
): Promise<FetchedSource> {
  // zotero-types declares blobToHTMLDocument as answering a Document, but the function
  // is async (utilities_internal.js), so its answer is awaited as a promise.
  let page = await Promise.resolve(
    Zotero.Utilities.Internal.blobToHTMLDocument(new Blob([await IOUtils.read(path)]), finalUrl),
  );
  let refreshUrl = Zotero.HTTP.getHTMLMetaRefreshURL(page, finalUrl);
  if (refreshUrl !== false && metaRedirects < 3) {
    return fetchFollowingMetaRefresh(refreshUrl, metaRedirects + 1);
  }
  return { kind: "html", finalUrl, document: page };
}

async function downloadSource(url: string, path: string): Promise<Response> {
  try {
    return await Zotero.HTTP.download(url, path);
  } catch (error) {
    if (!isHttpFailure(error)) {
      throw error;
    }
    throw new ApiError(502, "Source could not be fetched: " + error.message);
  }
}

// A new path in Zotero's temp directory for the source's body.
function sourceTempPath(): string {
  let file = Zotero.getTempDirectory();
  file.append(`local-write-api-source-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return file.path;
}

// Final URL of a completed download, after redirects. Zotero.HTTP.download answers the
// fetch Response, whose url is the URL that answered.
function finalResponseUrl(response: Response, url: string): string {
  if (response.url === "") {
    throw new Error(
      "Zotero.HTTP.download resolved GET " +
        url +
        " (status " +
        String(response.status) +
        ") with no response URL; inspect download() in zotero/zotero chrome/content/zotero/xpcom/http.js",
    );
  }
  return response.url;
}

// What a downloaded source's body is.
type SourceBody = "pdf" | "html" | "unidentified";

// The body a Content-Type declares, in order: the PDF type anywhere in it declares a PDF,
// and an HTML media type declares an HTML page.
const DECLARED_BODIES: readonly (readonly [RegExp, "pdf" | "html"])[] = [
  [/application\/pdf/i, "pdf"],
  [/^(text\/html|application\/xhtml\+xml)/i, "html"],
];

// The declared body, or, when the Content-Type declares neither, a PDF when the final
// path names a PDF file.
function sourceBody(contentType: string | null, finalUrl: string): SourceBody {
  let declared = DECLARED_BODIES.find(
    ([mediaType]) => contentType !== null && mediaType.test(contentType),
  );
  if (declared !== undefined) {
    return declared[1];
  }
  return new URL(finalUrl).pathname.toLowerCase().endsWith(".pdf") ? "pdf" : "unidentified";
}
// A text request that succeeded always has a body; a null body is a fault.
export function responseTextOf(xhr: XMLHttpRequest, url: string): string {
  if (xhr.responseText === null) {
    throw new Error(url + " answered with no response text");
  }
  return xhr.responseText;
}

export function requestJSONResponse(
  url: string,
  successCodes: number[],
): Promise<ServiceAnswer<XMLHttpRequest>> {
  return requestService(url, {
    responseType: "json",
    successCodes,
    headers: { Accept: "application/json" },
  });
}

// A body that is not JSON, or does not match the service's documented shape, is
// the service's failure. With responseType "json", the XHR gives a null response
// for a body that is not JSON.
export function parseJSONResponse<S extends v.GenericSchema>(
  xhr: XMLHttpRequest,
  url: string,
  schema: S,
): ServiceAnswer<v.InferOutput<S>> {
  if (xhr.response === null) {
    return serviceFailure(url + " answered a body that is not JSON");
  }
  let parsed = v.safeParse(schema, xhr.response);
  if (!parsed.success) {
    return serviceFailure(url + " answered an unexpected body: " + v.summarize(parsed.issues));
  }
  return answered(parsed.output);
}

export async function requestJSON<S extends v.GenericSchema>(
  url: string,
  schema: S,
): Promise<ServiceAnswer<v.InferOutput<S>>> {
  let xhr = await requestJSONResponse(url, [200]);
  if (xhr.outcome === "failed") {
    return xhr;
  }
  return parseJSONResponse(xhr.value, url, schema);
}
