import * as v from "valibot";
import { ApiError, badRequest } from "./errors";
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

export async function fetchSource(url: string): Promise<FetchedSource> {
  let xhr: XMLHttpRequest;
  try {
    xhr = await Zotero.HTTP.request("GET", url, { responseType: "document" });
  } catch (error) {
    if (!isHttpFailure(error)) {
      throw error;
    }
    throw new ApiError(502, "Source could not be fetched: " + error.message);
  }
  return fetchedSource(xhr, url);
}

// Final URL of a completed request, after redirects. Zotero.HTTP.request resolves only
// once the response arrived, so the XHR always holds the URL that answered.
function finalResponseUrl(xhr: XMLHttpRequest, url: string): string {
  if (xhr.responseURL === "") {
    throw new Error(
      "Zotero.HTTP.request resolved GET " +
        url +
        " (status " +
        String(xhr.status) +
        ") with no responseURL; inspect request() in zotero/zotero chrome/content/zotero/xpcom/http.js",
    );
  }
  return xhr.responseURL;
}

// A response is a PDF when it declares the PDF type, or when it is not a parsed
// document and its final path names a PDF file.
function isPdfResponse(
  contentType: string | null,
  page: Document | null,
  finalUrl: string,
): boolean {
  if (contentType !== null && /application\/pdf/i.test(contentType)) {
    return true;
  }
  return page === null && new URL(finalUrl).pathname.toLowerCase().endsWith(".pdf");
}

// Classifies a fetched response as a PDF or an HTML page.
function fetchedSource(xhr: XMLHttpRequest, url: string): FetchedSource {
  let finalUrl = finalResponseUrl(xhr, url);
  let contentType = xhr.getResponseHeader("Content-Type");
  let page = xhr.responseXML;
  if (isPdfResponse(contentType, page, finalUrl)) {
    return { kind: "pdf", finalUrl };
  }
  if (page === null) {
    throw new SourceNotIdentifiedError(
      "Source is neither an HTML page nor a PDF (Content-Type: " + String(contentType) + ")",
      [],
    );
  }
  return { kind: "html", finalUrl, document: Zotero.HTTP.wrapDocument(page, finalUrl) };
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
