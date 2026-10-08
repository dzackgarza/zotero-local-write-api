import { handleAttachRequest } from "./attach";
import { bearerAuthFailure, PUBLIC_BASE_URL_PREF, TOKEN_PREF } from "./auth";
import {
  type EndpointConstructor,
  type EndpointRequest,
  type EndpointResult,
  type JsonPayload,
  log,
  type SendResponse,
  sendJSON,
} from "./responses";
import { handleWriteRequest } from "./write";
import { type ZoteroTranslatorsApi } from "./zotero-api";

let AttachEndpoint: EndpointConstructor | undefined;
let WriteEndpoint: EndpointConstructor | undefined;
let VersionEndpoint: EndpointConstructor | undefined;
let OpenApiEndpoint: EndpointConstructor | undefined;
let PLUGIN_CAPABILITIES = [
  "attach",
  "attach_bytes",
  "write",
  "version_probe",
  "health_probe",
  "import_bibtex",
  "import_by_identifier",
  "selected_collection",
  "sync",
  "run_javascript",
  "openapi_spec",
  "import_from_url",
  "resolve_url",
  "attach_standalone",
  "import_store_attachments",
  "recognition_held_from_sync",
  "import_by_identifier_existing",
];

// The request path of each endpoint the add-on registers.
function endpointPaths(): string[] {
  return [FULLTEXT_ATTACH_PATH, LOCAL_WRITE_PATH, VERSION_PATH, OPENAPI_PATH];
}

function pluginVersionPayload(): JsonPayload {
  return {
    success: true,
    healthy: true,
    status: "ok",
    message: "Local Write API is running.",
    version: PLUGIN_VERSION,
    addon_id: ADDON_ID,
    homepage_url: HOMEPAGE_URL,
    update_url: UPDATE_URL,
    endpoints: endpointsPayload(),
    compatibility: compatibilityPayload(),
    capabilities: PLUGIN_CAPABILITIES.slice(),
    translators_ready: translatorsReady,
  };
}

function endpointsPayload(): JsonPayload {
  return {
    attach: FULLTEXT_ATTACH_PATH,
    write: LOCAL_WRITE_PATH,
    version: VERSION_PATH,
    openapi: OPENAPI_PATH,
  };
}

function compatibilityPayload(): JsonPayload {
  return {
    strict_min_version: STRICT_MIN_VERSION,
    strict_max_version: STRICT_MAX_VERSION,
    tested_zotero_version: TESTED_ZOTERO_VERSION,
  };
}

// rootURI of the installed XPI, captured at startup; the bundled openapi.yaml
// is read back from it.
let pluginRootURI = "";
// Whether Zotero has loaded its translators; translator-backed operations fail before then.
let translatorsReady = false;

// The spec's single server entry is the loopback URL; a set publicBaseURL pref rewrites
// it so a schema imported by URL points at the tunnel hostname. Fail loud
// if that exact server line is absent rather than silently serving a spec
// that still points at loopback — the whole point of the pref is to not do
// that.
// A presence check plus a first-match replace cannot tell the servers entry from
// any other line that happens to contain the same URL — it would rewrite the wrong
// one and serve a spec still pointing at loopback while claiming to be published.
// Requiring exactly one occurrence makes that ambiguity impossible to reach.
function publishedSpecText(text: string, publicBaseUrl: string): string {
  let loopbackServer = "url: http://127.0.0.1:23119";
  let occurrences = text.split(loopbackServer).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      "openapi.yaml must contain exactly one '" +
        loopbackServer +
        "' entry to rewrite for publicBaseURL, found " +
        String(occurrences),
    );
  }
  return text.replace(loopbackServer, "url: " + publicBaseUrl.replace(/\/+$/, ""));
}

// Bundled into the XPI by build.py next to bootstrap.js. rootURI is a
// jar:file://…!/ URI for a packaged install, and Zotero.File.getContentsFromURLAsync
// cannot read those: it routes through Zotero.HTTP._parseURI, which reads
// nsIURI.username and throws NS_ERROR_FAILURE on a jar: URI. fetch() reads it
// directly in the add-on's privileged scope.
async function openApiSpecText(): Promise<string> {
  let response = await fetch(pluginRootURI + "openapi.yaml");
  if (!response.ok) {
    throw new Error("bundled openapi.yaml could not be read: HTTP " + String(response.status));
  }
  let text = await response.text();
  let publicBaseUrl = Zotero.Prefs.get(PUBLIC_BASE_URL_PREF, true);
  if (typeof publicBaseUrl === "string" && publicBaseUrl !== "") {
    return publishedSpecText(text, publicBaseUrl);
  }
  return text;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function install(): void {
  log("Installed " + PLUGIN_VERSION);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function startup({
  id,
  version,
  rootURI,
}: {
  id: string;
  version: string;
  rootURI: string;
}): Promise<void> {
  void id;
  void version;
  pluginRootURI = rootURI;
  log("Starting " + PLUGIN_VERSION);
  void (Zotero.Translators as ZoteroTranslatorsApi).init().then(
    () => {
      translatorsReady = true;
    },
    (error: unknown) => {
      log("Translator initialization failed: " + String(error));
    },
  );

  // Make the auth state visible in the log, so an operator can confirm the
  // write surface is gated before exposing it (or see that it is open).
  let tokenPref = Zotero.Prefs.get(TOKEN_PREF, true);
  let publicPref = Zotero.Prefs.get(PUBLIC_BASE_URL_PREF, true);
  let authEnabled = typeof tokenPref === "string" && tokenPref !== "";
  let published = typeof publicPref === "string" && publicPref !== "";
  log(
    authEnabled
      ? "Bearer auth ENABLED for /write and /attach (token pref set)"
      : published
        ? "Bearer auth REQUIRED but no token pref set: /write and /attach are " +
          "refused because publicBaseURL publishes them beyond loopback."
        : "Bearer auth DISABLED: /write and /attach are unauthenticated " +
          "(loopback-only default). Do not expose beyond loopback in this state.",
  );

  AttachEndpoint = function () {};
  AttachEndpoint.prototype = {
    supportedMethods: ["POST"],
    supportedDataTypes: ["application/json"],
    init: function (request: EndpointRequest) {
      let denied = bearerAuthFailure(request);
      if (denied !== null) {
        return denied;
      }
      return handleAttachRequest(request.data);
    },
  };

  WriteEndpoint = function () {};
  WriteEndpoint.prototype = {
    supportedMethods: ["POST"],
    supportedDataTypes: ["application/json"],
    init: function (request: EndpointRequest) {
      let denied = bearerAuthFailure(request);
      if (denied !== null) {
        return denied;
      }
      return handleWriteRequest(request.data);
    },
  };

  VersionEndpoint = function () {};
  VersionEndpoint.prototype = {
    supportedMethods: ["GET"],
    init: function (_data: unknown, sendResponse: SendResponse) {
      log("Received GET request to " + VERSION_PATH + " [v" + PLUGIN_VERSION + "]");
      sendJSON(sendResponse, 200, pluginVersionPayload());
    },
  };

  OpenApiEndpoint = function () {};
  OpenApiEndpoint.prototype = {
    supportedMethods: ["GET"],
    // The schema is a public static document: the GPT builder imports it by
    // URL and humans open it in a browser, so Zotero's browser-request block
    // is opted out for this path only.
    allowRequestsFromUnsafeWebContent: true,
    init: async function (_request: EndpointRequest): Promise<EndpointResult> {
      log("Received GET request to " + OPENAPI_PATH + " [v" + PLUGIN_VERSION + "]");
      return [200, "text/yaml; charset=utf-8", await openApiSpecText()];
    },
  };

  Zotero.Server.Endpoints[FULLTEXT_ATTACH_PATH] = AttachEndpoint;
  Zotero.Server.Endpoints[LOCAL_WRITE_PATH] = WriteEndpoint;
  Zotero.Server.Endpoints[VERSION_PATH] = VersionEndpoint;
  Zotero.Server.Endpoints[OPENAPI_PATH] = OpenApiEndpoint;
  log("Registered " + FULLTEXT_ATTACH_PATH + " endpoint");
  log("Registered " + LOCAL_WRITE_PATH + " endpoint");
  log("Registered " + VERSION_PATH + " endpoint");
  log("Registered " + OPENAPI_PATH + " endpoint");
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function onMainWindowLoad({ window: _window }: { window: Window }): void {
  // No window modifications needed
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function onMainWindowUnload({ window: _window }: { window: Window }): void {
  // No window modifications needed
}

// Reflect.deleteProperty is the non-syntactic form of `delete obj[key]`; the
// endpoint registry is keyed by request path, so the key is always computed.
function unregisterEndpoints(): void {
  for (let path of endpointPaths()) {
    Reflect.deleteProperty(Zotero.Server.Endpoints, path);
  }
  AttachEndpoint = undefined;
  WriteEndpoint = undefined;
  VersionEndpoint = undefined;
  OpenApiEndpoint = undefined;
  for (let path of endpointPaths()) {
    log("Unregistered " + path + " endpoint");
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function shutdown(
  { id, version, rootURI }: { id: string; version: string; rootURI: string },
  reason: number,
): void {
  void id;
  void version;
  void rootURI;
  if (reason === APP_SHUTDOWN) {
    return;
  }
  log("Shutting down " + PLUGIN_VERSION);
  unregisterEndpoints();
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function uninstall(): void {
  log("Uninstalled " + PLUGIN_VERSION);
}
