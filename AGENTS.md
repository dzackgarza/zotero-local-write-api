# AGENTS.md

## OpenAPI Contract

[`openapi.yaml`](./openapi.yaml): single source of truth for all request/response shapes.
README must not duplicate schemas; only link to `openapi.yaml`.

Change in `src/bootstrap.ts` to `runWrite`'s `operation` switch, handler's required/optional fields, or response payload fields → matching `openapi.yaml` edit, same diff (new/changed operation schema, updated `mapping` + `oneOf` entries in `WriteRequest`, updated `VersionResponse`/`AttachSuccessResponse` as needed).
No new/changed `case` in `runWrite`, or field read via `data.<field>`, without matching `openapi.yaml` update same diff.

Validate before commit:

```bash
npx --yes @redocly/cli lint openapi.yaml
```

## Local Zotero Runtime Proof

This repo is a Zotero add-on.
A passing package build is not proof that the add-on works.
Any behavior change to `src/bootstrap.ts`, endpoint contracts, packaging, manifest generation, or update metadata requires a live Zotero proof against the real local Zotero profile.

Required local proof path:

- Run `just build` from the repo root.
  The expected artifact is `local-write-api-<VERSION>.xpi`.
- Install that exact XPI into the active Zotero profile, not merely into the repo.
  The active profile used on this workstation is discovered from `~/.zotero/zotero/profiles.ini`; the installed add-on path has been `~/.zotero/zotero/9hz1exxd.default/extensions/local-write-api@dzackgarza.com.xpi`.
- Preserve the previously installed XPI with a timestamped backup before replacing it.
- Verify the built and installed files are identical with `sha256sum`.
- Restart Zotero with cache purge before testing the replaced XPI.
- Probe `http://127.0.0.1:23119/version` and confirm the expected version plus the expected capabilities.
  Version equality alone is not proof when rebuilding the same version.
- Run `EXPECTED_VERSION=$(cat VERSION) just smoke-live`.

`just smoke-live` is the canonical runtime proof.
It mutates the real Zotero library by creating a temporary item, attaching a PDF, exercising tag behavior, and trashing the temporary item.
Do not replace it with mocks, synthetic local files, helper-only tests, or a bare `/version` probe.

## Zotero Launch Procedure

When restarting Zotero from a non-interactive shell on this workstation, export the GUI session variables explicitly:

```bash
export DISPLAY=:0
export WAYLAND_DISPLAY=wayland-1
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus
```

For detached launch after replacing the XPI:

```bash
setsid env DISPLAY=:0 WAYLAND_DISPLAY=wayland-1 XDG_RUNTIME_DIR=/run/user/$(id -u) DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus zotero -purgecaches >/tmp/zotero-local-write-api-zotero.log 2>&1 < /dev/null &
```

For diagnosis, run foreground with debug output:

```bash
zotero -purgecaches -ZoteroDebugText
```

Stop any foreground debug session before finishing.
Do not leave an interactive Zotero process attached to the agent terminal.

## Update Channel Caveat

`updates.json` is the release-style update channel.
It is not a reliable same-version local development reload mechanism.
During local testing, replacing the profile XPI and restarting Zotero with `-purgecaches` is the reliable path.

Zotero also supports development proxy-file loading, but this repo's proven local path is currently the profile-XPI replacement flow above.

## Traps Observed

- Do not infer that a freshly built XPI is installed.
  Compare hashes against the profile extension path.
- Do not infer that the current add-on loaded from `version` alone.
  Check capability deltas and expected endpoint behavior.
- Do not use broad `pkill -f '/usr/lib/zotero/zotero-bin'` from a shell command that contains the same pattern.
  It can match and kill the controlling shell before the install step completes.
- Do not launch Zotero from headless shells without GUI session variables.
  The failure can be `Error: no DISPLAY environment variable specified`.
- Do not suppress Zotero startup output while diagnosing launch failures.
  Capture the real diagnostic first.
- Do not treat generated ignored artifacts as committed state.
  The XPI, generated `src/bootstrap.js`, generated `src/manifest.json`, `lcov.info`, and `node_modules/` are local build outputs unless the repo policy changes.
- Do not mix global QC migration edits with runtime proof claims.
  The live Zotero proof can pass while `just test` or pre-commit still fails under global QC.

## Global QC Notes

Use the top-level `just` recipes.
`just test` is the local QC contract and routes through the global Bun QC policy.
Current global QC may be stricter than the repo's local `bun run lint`.

When aligning this repo with global QC:

- Keep the runtime Zotero proof separate from static QC proof.
- Expect central Semgrep/ESLint/diff-coverage checks to flag existing TypeScript and generated or lockfile content until the repo has explicit policy alignment.
- Do not present a commit as available until hooks pass normally.
  Never bypass hooks.
- If the worktree already contains staged and unstaged QC migration edits, inspect both `git diff` and `git diff --cached` before adding any new file.
