import { BIBTEX_TRANSLATOR_ID } from "./identifier-import";
import { requestService, responseTextOf, runTranslation } from "./source-fetch";
import { type Identification, type MethodResult, miss } from "./source-results";
import {
  createImportTranslator,
  createTranslateSearch,
  createTranslateWeb,
  findIdentifiers,
  type Identifier,
  type TranslatorItemJSON,
  type WebTranslatorInfo,
} from "./zotero-api";

// Runs one web translator without saving. A translator whose detection found a
// choice of items (a search or table-of-contents page) marks the URL as not
// naming one work, and the method reports it as ambiguous without translating.
export async function translatePage(
  page: Document,
  translator: WebTranslatorInfo,
): Promise<MethodResult<TranslatorItemJSON>> {
  if (translator.itemType === "multiple") {
    return miss("ambiguous", translator.label + " lists several items");
  }
  let translate = createTranslateWeb(page);
  translate.setTranslator(translator);
  let items = await runTranslation(() =>
    translate.translate({ libraryID: false, saveAttachments: false }),
  );
  if (items.outcome === "failed") {
    return items;
  }
  return singleItem(items.value, translator.label + " returned");
}

// A method that yields no item misses; one that yields several cannot say which is meant.
function singleItem(items: TranslatorItemJSON[], source: string): MethodResult<TranslatorItemJSON> {
  if (items.length !== 1) {
    return miss(
      items.length === 0 ? "no_match" : "ambiguous",
      source + " " + items.length + " items",
    );
  }
  return { outcome: "identified", found: items[0] };
}

export function identifiedWork(
  item: MethodResult<TranslatorItemJSON>,
  translator: WebTranslatorInfo | null,
  message: string,
): MethodResult<Identification> {
  if (item.outcome !== "identified") {
    return item;
  }
  return { outcome: "identified", found: { json: item.found, translator, message } };
}

// A "webpage" item says only that the URL is a page; it does not identify a work.
export function translatedWork(
  item: MethodResult<TranslatorItemJSON>,
  translator: WebTranslatorInfo,
): MethodResult<Identification> {
  if (item.outcome === "identified" && item.found.itemType === "webpage") {
    return miss("no_match", translator.label + " describes only a web page");
  }
  return identifiedWork(item, translator, translator.label);
}

let XHTML_NS = "http://www.w3.org/1999/xhtml";

// The page's elements named NAME. In the add-on's DOM types, querySelectorAll and
// getElementsByTagName are untyped; the namespaced lookup is typed.
function htmlElements(page: Document, name: string): Element[] {
  return [...page.getElementsByTagNameNS(XHTML_NS, name)];
}

// The text in which identifier discovery looks for a DOI, ISBN, arXiv ID or
// PMID: the URLs and their query values, plus every <meta> content on the page.
// citation_reference tags are skipped because they name the works a paper cites.
export function identifierText(urls: string[], page: Document | null): string {
  let parts: string[] = [];
  for (let url of urls) {
    parts.push(url, ...new URL(url).searchParams.values());
  }
  if (page !== null) {
    parts.push(...metaContents(page));
  }
  return parts.join("\n");
}

function metaContents(page: Document): string[] {
  return htmlElements(page, "meta").flatMap((meta) => {
    let content = meta.getAttribute("content");
    let isReference = meta.getAttribute("name")?.toLowerCase() === "citation_reference";
    return content === null || isReference ? [] : [content];
  });
}

export function identifierKey(identifier: Identifier): string {
  let [type, value] = Object.entries(identifier)[0];
  if (type === "ISBN") {
    return "ISBN:" + Zotero.Utilities.toISBN13(value);
  }
  return type + ":" + value.toLowerCase();
}

// Resolves an identifier to metadata through Zotero's search translators
// (Crossref/DataCite for DOI, arXiv, PubMed, library catalogs for ISBN).
export async function resolveIdentifier(
  identifier: Identifier,
): Promise<MethodResult<TranslatorItemJSON>> {
  let search = createTranslateSearch();
  search.setIdentifier(identifier);
  let translators = await search.getTranslators();
  if (translators.length === 0) {
    return miss("no_match", "no translator resolves " + JSON.stringify(identifier));
  }
  search.setTranslator(translators);
  let items = await runTranslation(() =>
    search.translate({ libraryID: false, saveAttachments: false }),
  );
  if (items.outcome === "failed") {
    return items;
  }
  return singleItem(items.value, JSON.stringify(identifier) + " resolved to");
}

// Zotero.Utilities.extractIdentifiers takes any bare number of up to nine
// digits as a PMID when it finds nothing else, which suits a string the user
// typed as an identifier but not page text, where a year or a page count is
// such a number. A PubMed page is identified by the PubMed web translator.
export async function identifyByIdentifier(text: string): Promise<MethodResult<Identification>> {
  let distinct = new Map<string, Identifier>();
  for (let identifier of findIdentifiers(text)) {
    if (!("PMID" in identifier)) {
      distinct.set(identifierKey(identifier), identifier);
    }
  }
  if (distinct.size === 0) {
    return miss("no_match", "no DOI, ISBN or arXiv ID found");
  }
  if (distinct.size > 1) {
    return miss("ambiguous", "several identifiers found: " + [...distinct.keys()].join(", "));
  }
  let [key, identifier] = [...distinct.entries()][0];
  return identifiedWork(await resolveIdentifier(identifier), null, key);
}

// The BibTeX files a page links: an alternate <link> of BibTeX type, or an <a> whose href
// ends in .bib.
function publishedBibTeXLinks(page: Document, finalUrl: string): Set<string> {
  let links = new Set<string>();
  for (let link of htmlElements(page, "link")) {
    let rel = link.getAttribute("rel");
    let alternate = rel !== null && rel.split(/\s+/).includes("alternate");
    if (alternate && link.getAttribute("type") === "application/x-bibtex") {
      let href = link.getAttribute("href");
      if (href !== null) {
        links.add(new URL(href, finalUrl).href);
      }
    }
  }
  for (let anchor of htmlElements(page, "a")) {
    let href = anchor.getAttribute("href");
    if (href?.endsWith(".bib") === true) {
      links.add(new URL(href, finalUrl).href);
    }
  }
  return links;
}

export async function identifyByPublishedBibTeX(
  page: Document,
  finalUrl: string,
): Promise<MethodResult<Identification>> {
  let links = [...publishedBibTeXLinks(page, finalUrl)];
  if (links.length === 0) {
    return miss("no_match", "the page links no BibTeX");
  }
  if (links.length > 1) {
    return miss("ambiguous", "the page links several BibTeX files: " + links.join(", "));
  }
  let [bibUrl] = links;
  return identifiedWork(await importPublishedBibTeX(bibUrl), null, bibUrl);
}

async function importPublishedBibTeX(bibUrl: string): Promise<MethodResult<TranslatorItemJSON>> {
  let xhr = await requestService(bibUrl, { responseType: "text" });
  if (xhr.outcome === "failed") {
    return xhr;
  }
  let translator = createImportTranslator();
  translator.setTranslator(BIBTEX_TRANSLATOR_ID);
  translator.setString(responseTextOf(xhr.value, bibUrl));
  let items = await runTranslation(() =>
    translator.translate({ libraryID: false, saveAttachments: false }),
  );
  if (items.outcome === "failed") {
    return items;
  }
  return singleItem(items.value, bibUrl + " holds");
}
