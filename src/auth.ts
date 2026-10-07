import { type EndpointRequest, type EndpointResult, errorResult } from "./responses";

// Optional bearer-token auth for the write surface. With the token pref unset
// the API keeps its historical loopback-only, no-auth behavior. Setting the
// pref is REQUIRED before exposing these endpoints through a tunnel (see
// docs/gpt-action.md): a Custom GPT Action then sends the token as
// "Authorization: Bearer <token>", the one credential the GPT builder supports.
//
// The plugin cannot tell a loopback request from a tunnelled one (cloudflared
// forwards to 127.0.0.1:23119, so both look identical to Zotero's server), but it does
// know whether it has been published: publicBaseURL is set precisely when the surface is
// reachable off-loopback. bearerAuthFailure reads both prefs per request and refuses when
// the surface is published without a token, so clearing the token mid-run is caught
// immediately. The `just tunnel-setup`/`tunnel-install` recipes and the unit's
// ExecStartPre (justfile `_require-write-token`) still refuse at bring-up.
export let TOKEN_PREF = "extensions.zotero.localWriteAPI.token";
// When set, /openapi.yaml advertises this server URL instead of the loopback
// one, so the GPT builder can import the schema straight from the tunnel.
export let PUBLIC_BASE_URL_PREF = "extensions.zotero.localWriteAPI.publicBaseURL";

export function bearerAuthFailure(request: EndpointRequest): EndpointResult | null {
  // Loopback with no token is the documented default and stays open. What must never
  // happen is an unauthenticated surface being *published*: publicBaseURL is what makes
  // the plugin reachable beyond loopback, and both prefs are editable at runtime with no
  // restart, so the two are checked together on every request rather than once at
  // tunnel bring-up.
  let token = Zotero.Prefs.get(TOKEN_PREF, true);
  let published = Zotero.Prefs.get(PUBLIC_BASE_URL_PREF, true);
  let hasToken = typeof token === "string" && token !== "";
  if (!hasToken) {
    if (typeof published === "string" && published !== "") {
      return bearerDenied(
        request,
        "Write API is published via publicBaseURL but no token is configured",
      );
    }
    return null;
  }
  if (secretEquals(request.headers.authorization, "Bearer " + token)) {
    return null;
  }
  return bearerDenied(request, "Missing or invalid bearer token");
}

// A plain === short-circuits on the first mismatching byte, so response timing leaks
// how much of the token a caller has guessed. When publicBaseURL is set this surface is
// reachable from the internet, so the compare runs over the full length regardless of
// where the first difference falls. Length is still distinguishable, which is the
// standard trade-off for this construction.
function secretEquals(candidate: string | undefined, expected: string): boolean {
  if (candidate === undefined || candidate.length !== expected.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= candidate.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function bearerDenied(request: EndpointRequest, reason: string): EndpointResult {
  return [
    401,
    "application/json",
    JSON.stringify(
      // details.request echoes the body per the ErrorResponse schema; the 401
      // is documented on /write and /attach in openapi.yaml.
      errorResult("authorize", "auth", reason, {
        request: request.data,
      }),
    ),
  ];
}
