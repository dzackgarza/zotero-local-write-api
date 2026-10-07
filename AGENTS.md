# AGENTS.md

## OpenAPI Contract

[`openapi.yaml`](./openapi.yaml): single source of truth for all request/response shapes.
README must not duplicate schemas; only link to `openapi.yaml`.

When you change a module under `src/`, update `openapi.yaml` in the same diff for each of these changes:

- You add or change an entry in the `writeHandlers` operation table.
  Add or change the operation schema.
  Add or change its `mapping` and `oneOf` entries in `WriteRequest`.
- You add or change a request field that a handler reads as `data.<field>`.
  Set the field as required or optional in the operation schema.
- You add or change a response payload field.
  Update `VersionResponse` or `AttachSuccessResponse`.

`bun run openapi:contract` runs `tests/openapi-contract.test.ts`.
The test parses each `src/*.ts` module with the TypeScript compiler API.
It requires exactly one `writeHandlers` table and exactly one top-level declaration of each handler it names.
It asserts that `openapi.yaml` matches the `writeHandlers` entries 1:1.
It also asserts that `openapi.yaml` matches the handler field reads and the `successResult` calls 1:1.
The rule above is a reminder; the test is the authority.

Validate before commit:

```bash
bun run openapi:lint
bun run openapi:contract
```

## Source Layout

`bun run build` bundles `src/bootstrap.ts` and the modules it imports into `src/bootstrap.js`.
Zotero loads `bootstrap.js` as a classic script and calls `install`, `startup`, `shutdown` and `uninstall` as top-level functions.
A classic script that contains an `import` or `export` statement does not compile.
Thus `src/bootstrap.ts` declares the four lifecycle functions and exports nothing, and the bundle contains no `import` or `export` statement.
An XPI is a Zotero add-on package.
It is a ZIP archive with the `.xpi` extension.
`tests/build-artifacts.test.ts` builds the XPI and compiles its `bootstrap.js` as a classic script with `node:vm`.
The test then runs the script and asserts that the four lifecycle functions are on its global scope.
Build-time constants and Zotero's `APP_SHUTDOWN` are ambient declarations in `src/globals.d.ts`.

| Module | Contents |
| --- | --- |
| `bootstrap.ts` | Lifecycle, endpoint registration, `/version` payload, served `openapi.yaml` |
| `auth.ts` | Bearer-token gate for `/write` and `/attach` |
| `responses.ts` | Endpoint types, success and error envelopes, logging |
| `errors.ts` | `ApiError` and its HTTP status classes |
| `request-fields.ts` | Request field validation |
| `zotero-api.ts` | Named shapes for Zotero APIs that `zotero-types` under-models |
| `library.ts` | User-library lookups, citation keys, attachment file copies |
| `attach.ts` | `/attach` |
| `write.ts` | `/write` dispatch: `writeHandlers`, `sync`, `run_javascript` |
| `items.ts`, `item-copy-merge.ts`, `tags.ts`, `collections.ts` | Item, tag and collection operations |
| `identifier-import.ts` | `import_bibtex`, `import_by_identifier` |
| `import-from-url.ts`, `fallback-metadata.ts` | `import_from_url` |
| `resolve-url.ts` | `resolve_url` |
| `source-results.ts`, `source-fetch.ts`, `source-methods.ts`, `identify-page.ts`, `metadata-services.ts`, `pdf-recognition.ts`, `duplicates.ts` | Source identification shared by `import_from_url` and `resolve_url` |

## Local Zotero Runtime Proof

This repo is a Zotero add-on.
A passing package build is not proof that the add-on works.
Any behavior change to the add-on source in `src/`, endpoint contracts, packaging, manifest generation, or update metadata requires a live Zotero proof against the real local Zotero profile.

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

# Review Guidelines

These are additional requirements for reviewing agent work.
They do not replace the reviewer’s normal role, repo-specific standards, or technical judgment.
They provide the failure model that should shape the review.

The task is not merely to review a PR. The task is to decide whether a completion claim is true under the original objective.
The standard is full, correct, provable completion against the original requirements and repo guidelines.
Anything less is incomplete work that must not be treated as a win.

## Failure Model

Agents systematically produce impressive non-completion.
Common patterns are: polished summaries that imply finished work, caveats that quietly narrow the goal, reclassification without proof, delegated discovery presented as resolution, process language that substitutes for evidence, merged PRs treated as completion, passing checks treated as semantic proof, and artifacts that look substantial while leaving required work unowned.

Treat the agent’s summary, PR description, closing comment, issue closure, “goal completed” statement, and self-reported validations as untrusted.
They may be diagnostic pointers, but they are not evidence that the work is complete.
The evidence is the original issue or task, the code diff, tests, source/runtime facts, review comments, and produced artifacts.

## Decisive Invariants

Preserve the original success condition.
Read the original issue or task before accepting any restatement of it.
Keep its quantifiers intact: “all,” “complete,” "full subset," “zero remaining,” and similar terms cannot be quietly narrowed to examples, partial coverage, known blockers, or whatever the PR happened to touch.

Nothing required may disappear silently.
A required work family must be implemented, explicitly falsified, or validly reclassified with evidence that satisfies the issue’s own standard.
Partial implementation is not completion.
Future work is not completion.
Count reduction is not completion.
Resolved review threads are not completion.
Passing checks are not completion.
Substantial-looking work is not completion.
“Better than before” is not completion.

Goal substitution is the main thing to detect.
Ask whether the submitted work solves the original problem or merely produces a narrower artifact: cleaner metadata, a partial subset, a better explanation, a new issue, a renamed scope, a local workaround, or proof that someone should investigate later.

Technically correct administrative artifacts can be goal substitution.
A well-written issue, comment, audit note, scope statement, or enumeration of remaining work may be required, but it does not complete implementation, testing, proof, or downstream cleanup.
If the original task requires execution, the artifact is only useful insofar as it drives that execution; it must not become the stopping point.

Treat self-scoped remaining-work lists as a severe completion-laundering pattern.
When an agent is asked to enumerate remaining work, the domain is the original full completion requirement, not the agent’s intended subset, the PR’s current shape, a closeability criterion, or the work left after deferral and reclassification.
A valid enumeration subtracts only artifact-proven completed work from the original contract.
Deferrals, routed follow-ups, owner changes, and truthful incompletion notes remain unresolved work unless the original task explicitly made that administrative routing the whole deliverable.

If an agent repeats a narrowed enumeration after being corrected, treat that as a hard misalignment signal, not as an innocent wording issue.
The reviewer should identify the original full requirement, the scope the agent substituted, and the required work hidden by that substitution.

Silent reclassification is not resolution.
If the PR says remaining work is out-of-scope, research-owned, stub-owned, plugin-owned, downstream-owned, or future-owned, require evidence from the relevant source/runtime behavior, repo boundary, or original acceptance criteria.
A sentence in the PR description is not enough.

Ownership boundaries matter.
The submitting repo must prove its own claimed behavior and do the blocker forensics required by its own issue.
Do not require a receiving or downstream repo to classify another project’s internal uncertainty unless the original issue explicitly made that part of acceptance.
When an external issue is created, it should be written for that receiving repo, not for a reader who already knows the submitting repo’s context.

## Evidence Expectations

Review tests as evidence, not as decoration.
Valid tests exercise the real production path or semantic requirement.
Be skeptical of helper-only tests, tautologies, assertions of the implementation’s own output, bypasses around the runtime/plugin/stub path, example-only coverage where the issue required full coverage, weakened assertions, and missing invalid-nearby cases where the fix could overgeneralize.

For plugin work, the evidence should usually distinguish valid generic behavior from invalid nearby ordinary Python and should not hard-code a downstream consumer.
For stubs work, the evidence should be source-backed: the upstream surface exists, the stub matches public behavior, no fake API is added, no Any/object opacity escape is introduced, and inherited-method inflation is not used unless source exposes that surface.

Watch for code-level laundering: hard-coded consumer names, support for local research abstractions as if they were external API, fake stubs, broad Any/object escapes, line suppressions, diagnostic filtering, deletion of required data, broad type widening, and any move that makes checks pass by weakening the problem instead of solving it.

## When Acting on Review Feedback

A positive disposition requires a commit.

Do not resolve an accepted review comment until the code/proof remediation is committed and the reply cites the commit.

Never reply “accepted,” “aligned,” “fixed,” “addressed,” or “will address” to a review thread unless the remediation is already committed.
A thread cannot be resolved on intent or future work.

Every substantive review item must receive its visible thread- or surface-local disposition and evidence before resolution.
The canonical field contract and state machine live in [[pr-feedback-triage/SKILL|pr-feedback-triage]]. Do not create top-level disposition ledgers or tracked review-log files.
Migrate legacy ledger-only resolutions by posting the canonical disposition and evidence on each affected thread before treating it as closed.

Review comments are not implementation specs.
The worker must translate accepted feedback into first-principles remediation requirements before assigning implementation.

For each comment:
- Identify the concern.
- Identify the proposed fix.
- Decide whether the concern is true under global + repo policy.
- Decide whether the proposed fix preserves those policies.
- If the concern is true but the fix is wrong, apply a policy-compatible remediation.

## Writing the Review

Write nuanced feedback for an intelligent reader.
Do not force a machine-readable template, a mandatory table, or a simplistic pass/fail label when prose communicates the situation better.
Do make the completion judgment clear: whether the original task can be considered complete, what evidence supports that judgment, and which unresolved requirements block completion if any remain.

Do not foreground effort, progress, good intentions, volume of work, or “substantial” partial implementation when required work remains.
Mention completed pieces only when they are necessary to identify the exact remaining blockers or to prevent redoing already-correct work.
Do not compare incomplete work to “no work done” or “completely fake work”; compare it to the expected standard: the task done correctly, completely, and provably.

When required work remains, lead with the incompleteness and the concrete blockers.
Do not make the reader excavate the missing work from beneath praise, context-setting, or a narrative of what did get done.

Nuance belongs in the evidence and blocker analysis, not in softening the completion standard.
The review should make it easy to finish the work, not easy to feel satisfied with less than the original contract required.

> Optimized tool-use workflow for agents: see [SDL.md](./SDL.md).
