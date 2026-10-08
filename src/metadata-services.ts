import * as v from "valibot";
import {
  parseJSONResponse,
  requestJSON,
  requestJSONResponse,
  requestService,
} from "./source-fetch";
import { identifiedWork, identifierKey, resolveIdentifier } from "./source-methods";
import {
  answered,
  type BibliographicSeed,
  type ExternalService,
  type Identification,
  type MethodResult,
  miss,
  type ServiceCandidate,
  serviceFailure,
} from "./source-results";
import { type Identifier, type TranslatorItemJSON } from "./zotero-api";

// Title normalization from zotero/zotero chrome/content/zotero/xpcom/duplicates.js
// `normalizeString`: strip diacritics, ASCII punctuation to spaces, lowercase.
export function normalizeText(value: string): string {
  return Zotero.Utilities.removeDiacritics(value)
    .replace(/[ !-/:-@[-`{-~]+/g, " ")
    .trim()
    .toLowerCase();
}

function yearOf(date: string | undefined): string | null {
  if (date === undefined || date === "") {
    return null;
  }
  // strToDate leaves year undefined when the date names no year.
  let year = Zotero.Date.strToDate(date).year;
  return year === undefined ? null : year;
}

// What the external services search by: the title, first author's surname and
// year of the page's own metadata, when the page describes only itself.
export function seedFromJSON(json: TranslatorItemJSON): BibliographicSeed | null {
  let title = json.title?.trim();
  let creator = json.creators?.[0];
  let surname = creator?.lastName ?? creator?.name?.trim().split(/\s+/).pop();
  if (title === undefined || title === "" || surname === undefined || surname === "") {
    return null;
  }
  return { title, surname, year: yearOf(json.date) };
}

// A candidate is the seed's work when the normalized titles are equal, the
// seed's surname is one of the candidate's author name tokens, and the years
// agree whenever both are known. Title equality alone would confuse two works
// of the same name (Tate 1974 and Silverman 1986 are both "The Arithmetic of
// Elliptic Curves").
function matchesSeed(seed: BibliographicSeed, candidate: ServiceCandidate): boolean {
  if (normalizeText(candidate.title) !== normalizeText(seed.title)) {
    return false;
  }
  let surname = normalizeText(seed.surname);
  let authorTokens = candidate.authors.flatMap((name) => normalizeText(name).split(" "));
  if (!authorTokens.includes(surname)) {
    return false;
  }
  return seed.year === null || candidate.year === null || seed.year === candidate.year;
}

// Records without a title or an author name cannot match a seed, so they are no
// candidates.
function serviceCandidates<R>(
  records: R[],
  toCandidate: (record: R) => ServiceCandidate | null,
): ServiceCandidate[] {
  return records
    .map(toCandidate)
    .filter((candidate): candidate is ServiceCandidate => candidate !== null);
}

function crossrefAuthorNames(authors: { family?: string; name?: string }[]): string[] {
  return authors.flatMap((author) => {
    if (author.family !== undefined) {
      return [author.family];
    }
    return author.name === undefined ? [] : [author.name];
  });
}

function atomText(element: Element, name: string): string | null {
  let text = element.getElementsByTagNameNS(ATOM_NS, name)[0]?.textContent;
  return text === undefined || text === null ? null : text.trim();
}

function atomAuthors(entry: Element): string[] {
  return [...entry.getElementsByTagNameNS(ATOM_NS, "author")].flatMap((author) => {
    let name = atomText(author, "name");
    return name === null ? [] : [name];
  });
}

function arxivCandidate(entry: Element): ServiceCandidate | null {
  let title = atomText(entry, "title");
  let id = atomText(entry, "id");
  let authors = atomAuthors(entry);
  if (title === null || id === null || authors.length === 0) {
    return null;
  }
  let arXiv = id.match(/abs\/(.+?)(?:v\d+)?$/)?.[1];
  let published = atomText(entry, "published");
  return {
    title: title.replace(/\s+/g, " "),
    authors,
    year: published === null ? null : published.slice(0, 4),
    identifier: arXiv === undefined ? null : { arXiv },
  };
}

// The first ISBN of the edition Open Library ranks first; the other ISBNs of
// that edition are its other formats.
function firstEditionIsbn(work: OpenLibraryWork): string | undefined {
  let isbns = work.editions?.docs?.[0]?.isbn;
  return isbns === undefined
    ? undefined
    : isbns.map((value) => Zotero.Utilities.cleanISBN(value)).find((value) => value !== false);
}

function openLibraryCandidate(work: OpenLibraryWork): ServiceCandidate | null {
  if (work.title === undefined || work.author_name === undefined) {
    return null;
  }
  let isbn = firstEditionIsbn(work);
  return {
    title: work.title,
    authors: work.author_name,
    year: work.first_publish_year === undefined ? null : String(work.first_publish_year),
    identifier: isbn === undefined ? null : { ISBN: Zotero.Utilities.toISBN13(isbn) },
  };
}

// https://api.crossref.org/swagger-ui/index.html, /works
let CrossrefWorks = v.object({
  message: v.object({
    items: v.array(
      v.object({
        DOI: v.string(),
        title: v.optional(v.array(v.string())),
        author: v.optional(
          v.array(v.object({ family: v.optional(v.string()), name: v.optional(v.string()) })),
        ),
        issued: v.optional(
          v.object({ "date-parts": v.optional(v.array(v.array(v.nullable(v.number())))) }),
        ),
      }),
    ),
  }),
});
// https://api.zbmath.org/docs, /document/_search
let ZbmathSearch = v.object({
  result: v.array(
    v.object({
      title: v.optional(v.object({ title: v.optional(v.string()) })),
      year: v.optional(v.string()),
      contributors: v.optional(
        v.object({ authors: v.optional(v.array(v.object({ name: v.string() }))) }),
      ),
      links: v.optional(v.array(v.object({ type: v.string(), identifier: v.string() }))),
    }),
  ),
});
// https://openlibrary.org/dev/docs/api/search
let OpenLibrarySearch = v.object({
  docs: v.array(
    v.object({
      title: v.optional(v.string()),
      author_name: v.optional(v.array(v.string())),
      first_publish_year: v.optional(v.number()),
      editions: v.optional(
        v.object({
          docs: v.optional(v.array(v.object({ isbn: v.optional(v.array(v.string())) }))),
        }),
      ),
    }),
  ),
});
type OpenLibraryWork = v.InferOutput<typeof OpenLibrarySearch>["docs"][number];
type CrossrefWork = v.InferOutput<typeof CrossrefWorks>["message"]["items"][number];
type ZbmathDocument = v.InferOutput<typeof ZbmathSearch>["result"][number];

function crossrefCandidate(work: CrossrefWork): ServiceCandidate | null {
  let title = work.title?.[0];
  if (title === undefined || work.author === undefined) {
    return null;
  }
  let year = work.issued?.["date-parts"]?.[0]?.[0];
  return {
    title,
    authors: crossrefAuthorNames(work.author),
    year: typeof year === "number" ? String(year) : null,
    identifier: { DOI: work.DOI },
  };
}

function zbmathCandidate(document: ZbmathDocument): ServiceCandidate | null {
  let title = document.title?.title;
  let authors = document.contributors?.authors;
  if (title === undefined || authors === undefined) {
    return null;
  }
  let doi = document.links?.find((link) => link.type === "doi")?.identifier;
  return {
    title,
    authors: authors.map((author) => author.name),
    year: document.year === undefined ? null : document.year,
    identifier: doi === undefined ? null : { DOI: doi },
  };
}

let ATOM_NS = "http://www.w3.org/2005/Atom";

export let EXTERNAL_SERVICES: ExternalService[] = [
  {
    name: "Crossref",
    async search(seed) {
      let url =
        "https://api.crossref.org/works?rows=" + EXTERNAL_SERVICE_CANDIDATE_LIMIT + "&select=DOI,title,author,issued" +
        "&query.bibliographic=" +
        encodeURIComponent(seed.title) +
        "&query.author=" +
        encodeURIComponent(seed.surname);
      let works = await requestJSON(url, CrossrefWorks);
      if (works.outcome === "failed") {
        return works;
      }
      return answered(serviceCandidates(works.value.message.items, crossrefCandidate));
    },
  },
  {
    name: "zbMATH Open",
    async search(seed) {
      let query = 'ti:"' + seed.title + '" au:' + seed.surname;
      let url =
        "https://api.zbmath.org/v1/document/_search?page=0&results_per_page=" + EXTERNAL_SERVICE_CANDIDATE_LIMIT +
        "&search_string=" +
        encodeURIComponent(query);
      // zbMATH answers a search with no results with 404.
      let xhr = await requestJSONResponse(url, [200, 404]);
      if (xhr.outcome === "failed") {
        return xhr;
      }
      if (xhr.value.status === 404) {
        return answered([]);
      }
      let found = parseJSONResponse(xhr.value, url, ZbmathSearch);
      if (found.outcome === "failed") {
        return found;
      }
      return answered(serviceCandidates(found.value.result, zbmathCandidate));
    },
  },
  {
    name: "arXiv",
    async search(seed) {
      let query = 'ti:"' + seed.title + '" AND au:' + seed.surname;
      let url =
        "https://export.arxiv.org/api/query?max_results=" + EXTERNAL_SERVICE_CANDIDATE_LIMIT + "&search_query=" +
        encodeURIComponent(query);
      let xhr = await requestService(url, { responseType: "document" });
      if (xhr.outcome === "failed") {
        return xhr;
      }
      let feed = xhr.value.responseXML;
      if (feed === null) {
        return serviceFailure("arXiv returned no Atom feed");
      }
      let entries = [...feed.getElementsByTagNameNS(ATOM_NS, "entry")];
      return answered(serviceCandidates(entries, arxivCandidate));
    },
  },
  {
    name: "Open Library",
    async search(seed) {
      let url =
        "https://openlibrary.org/search.json?limit=" + EXTERNAL_SERVICE_CANDIDATE_LIMIT +
        "&fields=key,title,author_name,first_publish_year,editions,editions.isbn" +
        "&title=" +
        encodeURIComponent(seed.title) +
        "&author=" +
        encodeURIComponent(seed.surname);
      let found = await requestJSON(url, OpenLibrarySearch);
      if (found.outcome === "failed") {
        return found;
      }
      return answered(serviceCandidates(found.value.docs, openLibraryCandidate));
    },
  },
];

// The distinct identifiers of the candidates that match the seed.
function matchingIdentifiers(
  seed: BibliographicSeed,
  candidates: ServiceCandidate[],
): Map<string, Identifier> {
  let matches = new Map<string, Identifier>();
  for (let candidate of candidates) {
    if (candidate.identifier !== null && matchesSeed(seed, candidate)) {
      matches.set(identifierKey(candidate.identifier), candidate.identifier);
    }
  }
  return matches;
}

export async function identifyByService(
  service: ExternalService,
  seed: BibliographicSeed,
): Promise<MethodResult<Identification>> {
  let candidates = await service.search(seed);
  if (candidates.outcome === "failed") {
    return candidates;
  }
  let matches = matchingIdentifiers(seed, candidates.value);
  if (matches.size === 0) {
    return miss("no_match", service.name + ": no record matches the title, author and year");
  }
  if (matches.size > 1) {
    let keys = [...matches.keys()].join(", ");
    return miss("ambiguous", service.name + ": several records match: " + keys);
  }
  let [key, identifier] = [...matches.entries()][0];
  return identifiedWork(await resolveIdentifier(identifier), null, service.name + ": " + key);
}
