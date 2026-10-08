import { ApiError } from "./errors";
import { type Identifier, type TranslatorItemJSON, type WebTranslatorInfo } from "./zotero-api";

// ── import_from_url ─────────────────────────────────────────────────
// One source URL in, one Zotero item out. Each method below is tried in order
// until one identifies the source as exactly one work; every try is recorded as
// an attempt, and the attempts are returned with the result or the 422 error.

export type SourceMethod =
  | "web_translator"
  | "page_metadata"
  | "identifier"
  | "published_bibtex"
  | "external_service"
  | "pdf_recognition";
type AttemptOutcome = "identified" | "no_match" | "ambiguous" | "failed";
export type Attempt = { method: SourceMethod; outcome: AttemptOutcome; message: string };

export class SourceNotIdentifiedError extends ApiError {
  attempts: Attempt[];
  constructor(message: string, attempts: Attempt[]) {
    super(422, message);
    this.name = "SourceNotIdentifiedError";
    this.attempts = attempts;
  }
}

// The tag of an item made from fallback_metadata: citable now, reviewed later.
export let UNRESOLVED_TAG = "metadata:unresolved";

// What a client does next with a source that no method identifies: send a
// page that Zotero identifies reliably, or send import_from_url again with the
// caller's own metadata. Each example is the form of a URL that a Zotero web
// translator claims (translators/arXiv.org.js, zbMATH.js, AMS MathSciNet.js)
// or of an identifier that import_by_identifier resolves.
export let SOURCE_REMEDIATION = {
  message:
    "Find the work at one of the alternative sources and import that URL or identifier, " +
    "or send import_from_url again with fallback_metadata (title, creators, year); the item " +
    "is then tagged " +
    UNRESOLVED_TAG +
    " for review.",
  alternative_sources: [
    { name: "arXiv", example: "https://arxiv.org/abs/<arXiv ID>" },
    { name: "DOI", example: "https://doi.org/<DOI>" },
    { name: "zbMATH Open", example: "https://zbmath.org/?q=an:<zbMATH number>" },
    { name: "MathSciNet", example: "https://mathscinet.ams.org/mathscinet/article?mr=<MR number>" },
    { name: "ISBN", example: "import_by_identifier with identifier <ISBN>" },
  ],
  fallback_field: "fallback_metadata",
};

// What a method found: exactly one work, no work, more than one work, or a
// failure that an external service or translator reported.
type ServiceFailure = { outcome: "failed"; message: string };
type MethodMiss = { outcome: "no_match" | "ambiguous"; message: string } | ServiceFailure;
export type MethodResult<T> = { outcome: "identified"; found: T } | MethodMiss;
// What an external service or translator answered, or the failure it reported.
export type ServiceAnswer<T> = { outcome: "answered"; value: T } | ServiceFailure;

export function miss(outcome: MethodMiss["outcome"], message: string): MethodMiss {
  return { outcome, message };
}

export function answered<T>(value: T): ServiceAnswer<T> {
  return { outcome: "answered", value };
}

export function serviceFailure(message: string): ServiceFailure {
  return { outcome: "failed", message };
}

// A method's result: metadata that describes exactly one work, not yet saved.
export type Identification = {
  json: TranslatorItemJSON;
  translator: WebTranslatorInfo | null;
  message: string;
};
// An attachment the translator named that Zotero could not store.
// title and url are null when the translator named none.
export type AttachmentFailure = { title: string | null; url: string | null; error: string };
export type ImportOutcome = {
  item: Zotero.Item;
  existing: boolean;
  method: SourceMethod | "caller_metadata";
  translator: WebTranslatorInfo | null;
  attachmentFailures: AttachmentFailure[];
};
// Where a new item goes, and whether it stores the full text Zotero gets for the source.
export type SaveTarget = { collectionIDs: number[]; storeAttachments: boolean };
export type FetchedSource =
  | { kind: "pdf"; finalUrl: string }
  | { kind: "html"; finalUrl: string; document: Document };
export type BibliographicSeed = { title: string; surname: string; year: string | null };
export type ServiceCandidate = {
  title: string;
  authors: string[];
  year: string | null;
  identifier: Identifier | null;
};
export type ExternalService = {
  name: string;
  search(seed: BibliographicSeed): Promise<ServiceAnswer<ServiceCandidate[]>>;
};

// Records a method's result as an attempt; the found work, or null for a miss.
export function recordAttempt<T extends { message: string }>(
  attempts: Attempt[],
  method: SourceMethod,
  result: MethodResult<T>,
): T | null {
  if (result.outcome === "identified") {
    attempts.push({ method, outcome: "identified", message: result.found.message });
    return result.found;
  }
  attempts.push({ method, outcome: result.outcome, message: result.message });
  return null;
}

export function translatorDetails(translator: WebTranslatorInfo | null) {
  return translator === null
    ? null
    : { translator_id: translator.translatorID, label: translator.label };
}

// The outcome for a work the library already holds: nothing new is saved.
export function existingOutcome(
  item: Zotero.Item,
  method: ImportOutcome["method"],
  translator: WebTranslatorInfo | null,
): ImportOutcome {
  return { item, existing: true, method, translator, attachmentFailures: [] };
}
