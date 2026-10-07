#!/usr/bin/env bash
# Refuse unless the LIVE Zotero write surface enforces a bearer token.
#
# Single source for the tunnel's auth precondition. Run by `just tunnel-setup`,
# `tunnel-install`, and `tunnel-restart` as a pre-flight, and by the systemd
# unit's ExecStartPre so the tunnel also re-verifies on every (re)start,
# including at boot. It probes the running plugin — the same per-request value
# the plugin enforces — rather than the delayed prefs.js snapshot.
#
# This is the start-time half of the guard. The plugin covers the rest: it
# refuses /write and /attach per request whenever publicBaseURL is set without a
# token, so clearing the pref while the unit runs is denied immediately rather
# than exposed until the next restart (see docs/gpt-action.md).
set -euo pipefail

base="${ZOTERO_LOCAL_BASE_URL:-http://127.0.0.1:23119}"
# curl exits non-zero only on a transport failure (it returns 0 for any HTTP
# status, including 401); let that propagate loudly instead of masking it.
if ! code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/write" \
    -H 'Content-Type: application/json' -d '{}'); then
    echo "Refusing: could not reach $base/write — is Zotero running?" >&2
    exit 1
fi
if [[ "$code" != "401" ]]; then
    echo "Refusing: unauthenticated POST /write returned $code, expected 401." >&2
    echo "The live write surface is NOT enforcing a token. Set" >&2
    echo "extensions.zotero.localWriteAPI.token in Zotero (Settings -> Advanced ->" >&2
    echo "Config Editor) before exposing the tunnel. See docs/gpt-action.md." >&2
    exit 1
fi
echo "Live write surface enforces a bearer token (unauthenticated POST /write -> 401)."
