import { EXTERNAL_SERVICES, identifyByService, seedFromJSON } from "./metadata-services";
import {
  identifierText,
  identifyByIdentifier,
  identifyByPublishedBibTeX,
  translatedWork,
  translatePage,
} from "./source-methods";
import {
  type Attempt,
  type BibliographicSeed,
  type Identification,
  recordAttempt,
  type SourceMethod,
} from "./source-results";
import { createTranslateWeb, type WebTranslatorInfo } from "./zotero-api";

// The generic translator that reads citation_*, Dublin Core, Open Graph and
// other embedded tags (translators/Embedded Metadata.js).
let EMBEDDED_METADATA_TRANSLATOR_ID = "951c027d-74ac-47d4-a107-9c3069ab7b48";

type PageIdentification = Identification & { method: SourceMethod };

// Records that a method had nothing to work on.
function recordNoMatch(attempts: Attempt[], method: SourceMethod, message: string): void {
  attempts.push({ method, outcome: "no_match", message });
}

async function identifyBySiteTranslator(
  page: Document,
  detected: WebTranslatorInfo[],
  attempts: Attempt[],
): Promise<PageIdentification | null> {
  let siteTranslators = detected.filter(
    (translator) => translator.translatorID !== EMBEDDED_METADATA_TRANSLATOR_ID,
  );
  if (siteTranslators.length === 0) {
    recordNoMatch(attempts, "web_translator", "no site translator detected the page");
  }
  for (let translator of siteTranslators) {
    let item = await translatePage(page, translator);
    let found = recordAttempt(attempts, "web_translator", translatedWork(item, translator));
    if (found) {
      return { ...found, method: "web_translator" };
    }
  }
  return null;
}

// The page's embedded citation metadata identifies the work, or names the title and
// author that the external services search for.
async function identifyByPageMetadata(
  page: Document,
  detected: WebTranslatorInfo[],
  attempts: Attempt[],
): Promise<{ found: PageIdentification | null; seed: BibliographicSeed | null }> {
  let embedded = detected.find(
    (translator) => translator.translatorID === EMBEDDED_METADATA_TRANSLATOR_ID,
  );
  if (embedded === undefined) {
    recordNoMatch(attempts, "page_metadata", "the page carries no embedded citation metadata");
    return { found: null, seed: null };
  }
  let item = await translatePage(page, embedded);
  let found = recordAttempt(attempts, "page_metadata", translatedWork(item, embedded));
  return {
    found: found === null ? null : { ...found, method: "page_metadata" },
    seed: item.outcome === "identified" ? seedFromJSON(item.found) : null,
  };
}

async function identifyByServices(
  seed: BibliographicSeed | null,
  attempts: Attempt[],
): Promise<PageIdentification | null> {
  if (seed === null) {
    recordNoMatch(attempts, "external_service", "the page names no title and author to search for");
    return null;
  }
  for (let service of EXTERNAL_SERVICES) {
    let found = recordAttempt(attempts, "external_service", await identifyByService(service, seed));
    if (found) {
      return { ...found, method: "external_service" };
    }
  }
  return null;
}

async function identifyByPageIdentifier(
  requestedUrl: string,
  finalUrl: string,
  page: Document,
  attempts: Attempt[],
): Promise<PageIdentification | null> {
  let found = recordAttempt(
    attempts,
    "identifier",
    await identifyByIdentifier(identifierText([requestedUrl, finalUrl], page)),
  );
  return found === null ? null : { ...found, method: "identifier" };
}

// An identifier in the URLs or the page, then the BibTeX record the page links to.
async function identifyByPublishedRecord(
  requestedUrl: string,
  finalUrl: string,
  page: Document,
  attempts: Attempt[],
): Promise<PageIdentification | null> {
  let byIdentifier = await identifyByPageIdentifier(requestedUrl, finalUrl, page, attempts);
  if (byIdentifier) {
    return byIdentifier;
  }
  let byBibTeX = recordAttempt(
    attempts,
    "published_bibtex",
    await identifyByPublishedBibTeX(page, finalUrl),
  );
  return byBibTeX === null ? null : { ...byBibTeX, method: "published_bibtex" };
}

export async function identifyPage(
  requestedUrl: string,
  finalUrl: string,
  page: Document,
  attempts: Attempt[],
): Promise<PageIdentification | null> {
  let detected = await createTranslateWeb(page).getTranslators();
  let bySiteTranslator = await identifyBySiteTranslator(page, detected, attempts);
  if (bySiteTranslator) {
    return bySiteTranslator;
  }
  let byPageMetadata = await identifyByPageMetadata(page, detected, attempts);
  if (byPageMetadata.found) {
    return byPageMetadata.found;
  }
  let byPublishedRecord = await identifyByPublishedRecord(requestedUrl, finalUrl, page, attempts);
  return byPublishedRecord ?? identifyByServices(byPageMetadata.seed, attempts);
}
