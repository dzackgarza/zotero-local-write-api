# Schemathesis live proofs

These suites test the add-on's HTTP contract (`openapi.yaml`) against a **real running Zotero**, because the repository's policy is that mocks are not runtime proof.

- `test_stateful.py` — the create/note/collection/tag/merge/restore/trash workflow with independent Zotero read-back.
  Safe against any library: unique-prefixed objects, cleaned up in a `finally`. Run with `just schemathesis-stateful-live`.

- Generic fuzzing — `schemathesis.toml` + `hooks.py`. **Mutating with no per-case cleanup**, so it must run against a disposable profile and library, never a real one.
  Run with `just schemathesis-fuzz-live`.

## Disposable profile requirement

The generic fuzz generates arbitrary positive requests.
It must target a Zotero started on a throwaway profile whose `extensions.zotero.dataDir` points at an empty, disposable library.
Confirm the library is empty before fuzzing:

```bash
curl -s "http://127.0.0.1:23119/api/users/0/items?limit=1"   # must be []
```

A profile alone is not enough: Zotero's library lives in the *data directory* (a pref), which defaults to `~/Zotero`. A disposable profile with the default data dir would fuzz the real library.

### Provisioning runbook

Each step is a tested recipe or the proven `install-live` flow.
Steps 3–6 stop and restart Zotero, so run them when it is safe to close the current session.
A fresh sideload registers *disabled* on first boot, hence the approve-then-reboot (steps 4–5).

```bash
# 1. Provision the disposable profile + empty data dir (idempotent; leaves the
#    Default=1 profile alone). Prints: NAME<TAB>DIR<TAB>DATADIR
read -r NAME DIR DATA < <(just _provision-disposable-profile)

# 2-3. Build + install the working-tree XPI into it and boot once. The version
#      wait fails here because the sideload is still disabled — that is expected.
ZOTERO_PROFILE_NAME="$NAME" ZOTERO_PROFILE_DIR="$DIR" just install-live || true

# 4-5. Approve the now-registered add-on and boot again; this time it loads.
just _approve-sideloaded-addon "$DIR"
ZOTERO_PROFILE_NAME="$NAME" ZOTERO_PROFILE_DIR="$DIR" just install-live

# 6. SAFETY GATE — must print []. If not, stop: you are on the wrong library.
curl -s "http://127.0.0.1:23119/api/users/0/items?limit=1"

# 7. Fuzz.
just schemathesis-fuzz-live
```

When finished, restore your normal profile with a plain `just install-live` (no `ZOTERO_PROFILE_*`), and delete `$DIR` / `$DATA` plus the disposable section in `profiles.ini` if you want it gone.

## Known residual findings (Zotero core, not this add-on)

Two generic-fuzz findings are **not** defects in this add-on and are **not** silenced in `schemathesis.toml`, because weakening a check to hide a real 5xx or content-type is exactly the pattern this repo bans.
They are recorded here instead, with the evidence that they originate in Zotero's core HTTP server, below the add-on's endpoints:

1. **`TRACE {/version,/write,/attach}` → 501 Not Implemented.** The endpoints declare `supportedMethods` (`["POST"]` / `["GET"]`); an unsupported method is rejected by `Zotero.Server` before dispatch.
   The add-on source in `src/` never emits 501 (grep it), so every 501 is core method-dispatch.
   Correct REST would be 405, but that lives in Zotero, not in an add-on.
   Reproduce: `curl -X TRACE http://127.0.0.1:23119/version`.

2. **`POST /attach` with a transport-malformed body (e.g. a lone NUL byte) → 400 with a non-JSON `Content-Type`.** The endpoints declare `supportedDataTypes: ["application/json"]`; a body that is not parseable JSON is rejected by the core server before the handler runs.
   `sendJSON` always sets `application/json`, so this response is core's, not the add-on's. Reproduce: `curl -X POST -H 'Content-Type: application/json' --data-binary $'\x00' http://127.0.0.1:23119/attach`.

Both are candidates for an upstream Zotero report; neither is fixable from the add-on.
The fuzz deliberately still surfaces them rather than allow-listing the status/content-type, so a genuine new 5xx or wrong content-type in the add-on's own handlers cannot hide behind an allowance.

Real add-on defects the generic fuzz found (all fixed, see git log): a `null` body hanging `POST /write` forever, a `null` body 500ing `POST /attach`, and `create_item` accepting an unknown `item_type` as a 500 instead of a 400.
