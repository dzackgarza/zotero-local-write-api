// A Zotero HTTP endpoint is registered as a constructor function whose prototype carries
// the request metadata and init handler. The slot is cleared to undefined on shutdown.
// Single-parameter init receives {headers, data, ...} and returns [status, contentType,
// body]; the two-parameter form receives (data, sendResponse). Both are dispatched by
// arity in zotero/zotero chrome/content/zotero/xpcom/server/server.js.
export type EndpointResult = [number, string, string];
type EndpointPrototype = {
  supportedMethods: string[];
  supportedDataTypes?: string[];
  allowRequestsFromUnsafeWebContent?: boolean;
  init: (...args: never[]) => void | EndpointResult | Promise<void | EndpointResult>;
};
export type EndpointConstructor = { (): void; prototype: EndpointPrototype };

// Header names arrive lowercased (server.js parses them into Zotero.Server.Headers
// with lowercase keys).
export type EndpointRequest = {
  headers: Record<string, string | undefined>;
  data: unknown;
};

export type RequestData = Record<string, unknown>;
export type SendResponse = (status: number, contentType: string, body: string) => void;
export type JsonPayload = Record<string, unknown>;

export function log(msg: string): void {
  Zotero.debug("Local Write API: " + msg);
}

export function sendJSON(sendResponse: SendResponse, statusCode: number, payload: JsonPayload): void {
  sendResponse(statusCode, "application/json", JSON.stringify(payload));
}

export function successResult(operation: string, details?: JsonPayload, extra?: JsonPayload): JsonPayload {
  let payload: JsonPayload = {
    success: true,
    operation: operation,
    stage: "completed",
    version: PLUGIN_VERSION,
  };
  if (details) {
    payload.details = details;
  }
  if (extra) {
    return { ...payload, ...extra };
  }
  return payload;
}

export function errorResult(
  operation: string,
  stage: string,
  error: string,
  details: JsonPayload,
): JsonPayload {
  return {
    success: false,
    operation: operation,
    stage: stage,
    error: error,
    details: details,
    version: PLUGIN_VERSION,
  };
}

export function jsonResult(status: number, payload: JsonPayload): EndpointResult {
  return [status, "application/json", JSON.stringify(payload)];
}
