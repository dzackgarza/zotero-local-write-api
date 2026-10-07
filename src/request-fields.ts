import { badRequest } from "./errors";
import { type JsonPayload, type RequestData } from "./responses";

// Zotero hands the endpoint whatever JSON the client sent, including `null`,
// arrays, and scalars. Dereferencing those throws a raw TypeError instead of a
// classified failure, so every endpoint narrows the body here first.
export function requireRequestObject(data: unknown): RequestData {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw badRequest("Request body must be a JSON object");
  }
  return data as RequestData;
}

export function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw badRequest(fieldName + " must be a string");
  }
  return value;
}

export function requireNonEmptyString(value: unknown, fieldName: string): string {
  let cleaned = requireString(value, fieldName).trim();
  if (!cleaned) {
    throw badRequest(fieldName + " must be a non-empty string");
  }
  return cleaned;
}

export function optionalNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  let cleaned = value.trim();
  return cleaned ? cleaned : null;
}

export function requireObject(value: unknown, fieldName: string): JsonPayload {
  // `typeof value !== "object"` already rejects every other falsy value; null is
  // the one that reports as "object" and so needs its own comparison.
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw badRequest(fieldName + " must be an object");
  }
  return value as JsonPayload;
}

export function normalizeStringList(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw badRequest(fieldName + " must be an array of strings");
  }
  let normalized: string[] = [];
  let seen = new Set<string>();
  for (let entry of value) {
    if (typeof entry !== "string") {
      throw badRequest(fieldName + " entries must be strings");
    }
    // NFC before trim/dedupe: Zotero normalizes text when it stores it, so raw
    // caller input must be normalized to the same form or it silently fails to
    // match what is stored. Without this, add_item_tags(X) followed by
    // remove_item_tags(X) with the identical string X is a no-op that still
    // reports success (removed_count: 0), and the dedupe below counts "e" +
    // U+0301 and U+00E9 as two different tags when Zotero stores one.
    let cleaned = entry.normalize("NFC").trim();
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }
    normalized.push(cleaned);
    seen.add(cleaned);
  }
  return normalized;
}

// A request field that the request's other fields make required; its absence is a bad request.
export function requirePresent(value: string | null, message: string): string {
  if (value === null) {
    throw badRequest(message);
  }
  return value;
}
