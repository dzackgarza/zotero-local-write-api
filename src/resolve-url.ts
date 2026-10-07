import { identifyPage } from "./identify-page";
import { recognizeParent } from "./pdf-recognition";
import { type JsonPayload, type RequestData, successResult } from "./responses";
import { fetchSource, requireHttpUrl } from "./source-fetch";
import { identifierText, identifyByIdentifier } from "./source-methods";
import {
  type Attempt,
  type Identification,
  type MethodResult,
  recordAttempt,
  type SourceMethod,
  SourceNotIdentifiedError,
  translatorDetails,
} from "./source-results";
import { type TranslatorItemJSON, type WebTranslatorInfo } from "./zotero-api";

// ── resolve_url ─────────────────────────────────────────────────────
// import_from_url without the save: the same fetch and the same methods in the
// same order, answered with the identified work as CSL-JSON. The recognizer
// can only save, so its parent item is converted and then erased.

// Zotero.Utilities.Item.itemToCSLJSON accepts a Zotero.Item or translator item
// JSON; zotero-types does not declare it.
// Models zotero/utilities utilities_item.js `itemToCSLJSON`.
type CslItem = JsonPayload & { type: string };
type ItemUtilitiesApi = { itemToCSLJSON(item: Zotero.Item | TranslatorItemJSON): CslItem };
type Resolution = {
  csl: CslItem;
  itemType: string;
  method: SourceMethod;
  translator: WebTranslatorInfo | null;
};

function itemToCsl(item: Zotero.Item | TranslatorItemJSON): CslItem {
  let utilities = Zotero.Utilities as typeof Zotero.Utilities & { Item: ItemUtilitiesApi };
  return utilities.Item.itemToCSLJSON(item);
}

function resolveIdentification(
  identification: Identification & { method: SourceMethod },
): Resolution {
  return {
    csl: itemToCsl(identification.json),
    itemType: identification.json.itemType,
    method: identification.method,
    translator: identification.translator,
  };
}

async function recognizeWithoutSaving(
  finalUrl: string,
): Promise<MethodResult<{ csl: CslItem; itemType: string; message: string }>> {
  let recognized = await recognizeParent(finalUrl);
  if (recognized.outcome !== "identified") {
    return recognized;
  }
  let { parent, pdf } = recognized.found;
  try {
    let csl = itemToCsl(parent);
    // The CSL id is the URI of the parent, which is erased below.
    delete csl.id;
    let message = parent.getField("title");
    return { outcome: "identified", found: { csl, itemType: parent.itemType, message } };
  } finally {
    await pdf.eraseTx();
    await parent.eraseTx();
  }
}

async function resolvePdfSource(
  requestedUrl: string,
  finalUrl: string,
  attempts: Attempt[],
): Promise<Resolution | null> {
  let recognized = recordAttempt(
    attempts,
    "pdf_recognition",
    await recognizeWithoutSaving(finalUrl),
  );
  if (recognized) {
    return {
      csl: recognized.csl,
      itemType: recognized.itemType,
      method: "pdf_recognition",
      translator: null,
    };
  }
  let byIdentifier = recordAttempt(
    attempts,
    "identifier",
    await identifyByIdentifier(identifierText([requestedUrl, finalUrl], null)),
  );
  if (byIdentifier) {
    return resolveIdentification({ ...byIdentifier, method: "identifier" });
  }
  return null;
}

export async function handleResolveUrl(data: RequestData) {
  let url = requireHttpUrl(data.url);
  let attempts: Attempt[] = [];
  let source = await fetchSource(url);
  let resolution: Resolution | null;
  if (source.kind === "pdf") {
    resolution = await resolvePdfSource(url, source.finalUrl, attempts);
  } else {
    let identification = await identifyPage(url, source.finalUrl, source.document, attempts);
    resolution = identification === null ? null : resolveIdentification(identification);
  }
  if (resolution === null) {
    throw new SourceNotIdentifiedError("No method identified the source: " + url, attempts);
  }

  return successResult(
    "resolve_url",
    {
      url,
      final_url: source.finalUrl,
      translator: translatorDetails(resolution.translator),
      attempts,
    },
    { method: resolution.method, item_type: resolution.itemType, csl: resolution.csl },
  );
}
