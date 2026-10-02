qc-type := "bun"

# ai-review-ci contract variables consumed by doctor and workflow installers.
ai_review_ci_schema_version := "1"
ai_review_ci_profile := "bun"
ai_review_ci_ref := "main"
ai_review_ci_release_channel := "main"
ai_review_ci_workflow_template_version := "1"
ai_review_ci_local_delegation := "global-justfile"
ai_review_ci_default_branch := "main"

# Run immediate commit-tier QC
test-commit:
    @just -f ~/ai-review-ci/justfiles/bun.just -d . test-commit

# Run the full project suite before pushing
test-push:
    @just -f ~/ai-review-ci/justfiles/bun.just -d . test-push

# Run CI acceptance QC
test-ci:
    @just -f ~/ai-review-ci/justfiles/bun.just -d . test-ci

# Show the current version
version:
    @cat VERSION

# Type-check the TypeScript source
typecheck:
    bun tsc --noEmit

# Lint the TypeScript source
lint:
    bun run lint

# Compile TypeScript and build the XPI (does not bump version or release).
# The update manifest goes to a scratch path so a dev build never rewrites the
# tracked updates.json, whose hash must match the XPI on the GitHub release.
build:
    uv run build.py --updates-out "$(mktemp -d)/updates.json"

# Live runtime proof against a real Zotero with the current XPI installed
smoke-live:
    #!/usr/bin/env bash
    set -euo pipefail
    args=()
    if [[ -n "${EXPECTED_VERSION:-}" ]]; then
        args+=(--expected-version "${EXPECTED_VERSION}")
    fi
    if [[ -n "${ZOTERO_LOCAL_BASE_URL:-}" ]]; then
        args+=(--base-url "${ZOTERO_LOCAL_BASE_URL}")
    fi
    if [[ -n "${ZOTERO_LIBRARY_ID:-}" ]]; then
        args+=(--library-id "${ZOTERO_LIBRARY_ID}")
    fi
    if [[ -n "${ZOTERO_WRITE_API_TOKEN:-}" ]]; then
        args+=(--token "${ZOTERO_WRITE_API_TOKEN}")
    fi
    uv run examples/live_smoke.py "${args[@]}"

# Build the working-tree XPI and hot-install it into a Zotero profile, then
# restart Zotero with a cache purge so the current code is actually loaded, and
# wait until the add-on answers with the built version and its capabilities.
#
# This REPLACES the running add-on and RESTARTS Zotero (closing the current
# session). updates.json is a release channel, not a reliable local same-version
# reload, so the proven path is replace-profile-XPI + restart (AGENTS.md).
#
# This is the ONLY install path. Locally it targets the active Default=1 profile;
# CI sets ZOTERO_PROFILE_DIR (and ZOTERO_PROFILE_NAME, passed to -P) to target a
# disposable profile. The build -> byte-compare -> purgecache-restart -> version
# wait sequence is what catches the stale-build trap, so CI must not re-implement
# it: a second copy that drifts would prove something different from local.
#   ZOTERO_PROFILE_DIR   override the profile directory (default: Default=1)
#   ZOTERO_PROFILE_NAME  profile name for `zotero -P` (default: none)
[doc("Build, install, and restart Zotero so the working-tree XPI is live (RESTARTS Zotero)")]
install-live:
    #!/usr/bin/env bash
    set -euo pipefail
    version="$(cat VERSION)"
    xpi="local-write-api-${version}.xpi"

    # 1. Build from the working tree. The update manifest goes to a scratch path
    #    so this install never rewrites the tracked updates.json.
    uv run build.py --updates-out "$(mktemp -d)/updates.json"
    if [[ ! -f "$xpi" ]]; then
        echo "expected $xpi was not built" >&2
        exit 1
    fi

    # 2. Resolve the target profile: CI provides one, otherwise Default=1.
    profile_dir="${ZOTERO_PROFILE_DIR:-$(just _default-profile-dir)}"
    if [[ ! -d "$profile_dir" ]]; then
        echo "profile dir not found: $profile_dir" >&2
        exit 1
    fi
    ext_dir="${profile_dir}/extensions"
    installed="${ext_dir}/local-write-api@dzackgarza.com.xpi"

    # 3. Timestamped backup of the currently installed XPI.
    if [[ -f "$installed" ]]; then
        cp -p "$installed" "${installed}.bak.$(date +%Y%m%d-%H%M%S)"
    fi

    # 4. Install and verify the installed bytes match the build exactly. A
    #    matching version string is NOT proof when rebuilding the same version.
    mkdir -p "$ext_dir"
    cp "$xpi" "$installed"
    if [[ "$(sha256sum "$xpi" | cut -d' ' -f1)" != "$(sha256sum "$installed" | cut -d' ' -f1)" ]]; then
        echo "sha256 mismatch after install" >&2
        exit 1
    fi
    echo "installed $xpi -> $installed"

    # 5. Restart Zotero with cache purge. Stop by exact process name (-x), never
    #    pkill -f, whose pattern would match this recipe's own shell (AGENTS.md).
    if pgrep -x zotero-bin > /dev/null; then pkill -x zotero-bin; fi
    if pgrep -x zotero > /dev/null; then pkill -x zotero; fi
    sleep 3
    profile_args=()
    if [[ -n "${ZOTERO_PROFILE_NAME:-}" ]]; then
        profile_args+=(-P "${ZOTERO_PROFILE_NAME}")
    fi
    log="${ZOTERO_LOG:-/tmp/zotero-local-write-api-zotero.log}"
    setsid env \
        DISPLAY="${DISPLAY:-:0}" \
        WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-1}" \
        XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" \
        DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}" \
        zotero "${profile_args[@]}" -purgecaches >"$log" 2>&1 < /dev/null &

    # 6. Wait for the add-on to answer with the just-built version AND the
    #    capabilities the proofs rely on. Version alone would pass against a
    #    build that dropped an endpoint.
    base="${ZOTERO_LOCAL_BASE_URL:-http://127.0.0.1:23119}"
    probe="$(mktemp)"
    trap 'rm -f "$probe"' EXIT
    for _ in $(seq 1 60); do
        if curl -fsS "$base/version" -o "$probe" 2>/dev/null; then
            if python3 -c '
    import json, sys
    probe, expected = sys.argv[1], sys.argv[2]
    v = json.load(open(probe))
    if v.get("version") != expected:
        sys.exit(1)
    required = {"attach", "attach_bytes", "write", "version_probe", "import_bibtex"}
    missing = required - set(v.get("capabilities") or [])
    if missing:
        sys.exit(f"add-on is missing capabilities: {sorted(missing)}")
    ' "$probe" "$version"; then
                echo "Zotero up with version $version — run 'EXPECTED_VERSION=$version just smoke-live' to prove behavior"
                exit 0
            fi
        fi
        sleep 2
    done
    echo "Zotero did not report version $version within timeout; see $log" >&2
    exit 1

# Path of the active (Default=1) Zotero profile directory.
[private]
_default-profile-dir:
    #!/usr/bin/env python3
    # profiles.ini is INI, so it is parsed with configparser rather than matched
    # with a line-order-dependent regex: Default= and Path= may appear in either
    # order within a section, and only [Profile*] sections carry Default=1 (an
    # [Install*] section's Default= is a path, not a flag).
    import configparser, pathlib, sys

    ini = pathlib.Path.home() / ".zotero/zotero/profiles.ini"
    if not ini.is_file():
        sys.exit(f"no profiles.ini at {ini}")
    cfg = configparser.ConfigParser()
    cfg.read(ini)
    for name in cfg.sections():
        section = cfg[name]
        if "Path" not in section or section.get("Default", "").strip() != "1":
            continue
        path = pathlib.Path(section["Path"])
        if section.get("IsRelative", "1").strip() == "1":
            path = ini.parent / path
        print(path)
        break
    else:
        sys.exit(f"no Default=1 profile with a Path in {ini}")

# Provision (idempotently) a disposable Zotero profile + empty data directory
# for the mutating fuzz, and print `NAME<TAB>DIR<TAB>DATADIR`. Does NOT touch the
# Default=1 profile and does NOT start Zotero — the caller boots it via
# `ZOTERO_PROFILE_NAME=<name> ZOTERO_PROFILE_DIR=<dir> just install-live` and
# then approves the sideloaded add-on with `_approve-sideloaded-addon`.
#
# ZOTERO_ROOT overrides ~/.zotero so the file surgery can be tested off to the
# side. profiles.ini is written with case preserved because Mozilla's
# nsINIParser is case-sensitive (Name/Path/Default), unlike configparser.
[private]
_provision-disposable-profile name="lw-fuzz":
    #!/usr/bin/env python3
    import configparser, os, pathlib
    root = pathlib.Path(os.environ.get("ZOTERO_ROOT", pathlib.Path.home() / ".zotero"))
    name = "{{name}}"
    profile_dir = root / "zotero" / f"{name}-disposable"
    data_dir = root / f"{name}-data"
    profile_dir.mkdir(parents=True, exist_ok=True)
    data_dir.mkdir(parents=True, exist_ok=True)

    ini = root / "zotero" / "profiles.ini"
    cfg = configparser.ConfigParser()
    cfg.optionxform = str
    if ini.is_file():
        cfg.read(ini)
    # Reuse an existing section for this profile name, else the next free slot.
    section = next(
        (s for s in cfg.sections()
         if s.startswith("Profile") and cfg[s].get("Name") == name),
        None,
    )
    if section is None:
        i = 0
        while cfg.has_section(f"Profile{i}"):
            i += 1
        section = f"Profile{i}"
        cfg.add_section(section)
    cfg[section]["Name"] = name
    cfg[section]["IsRelative"] = "0"
    cfg[section]["Path"] = str(profile_dir)
    cfg[section].pop("Default", None)  # never the default profile
    with open(ini, "w") as f:
        cfg.write(f, space_around_delimiters=False)

    # Disposable library + local API on; no sync credentials, so this profile
    # cannot reach the online library.
    (profile_dir / "prefs.js").write_text(
        f'user_pref("extensions.zotero.dataDir", "{data_dir}");\n'
        'user_pref("extensions.zotero.useDataDir", true);\n'
        'user_pref("extensions.zotero.httpServer.enabled", true);\n'
        'user_pref("extensions.zotero.httpServer.localAPI.enabled", true);\n'
        'user_pref("extensions.zotero.firstRun2", false);\n'
        'user_pref("extensions.zotero.firstRun.skipFirefoxProfileAccessCheck", true);\n'
    )
    print(f"{name}\t{profile_dir}\t{data_dir}")

# Approve the add-on that Zotero registered as a disabled sideload on first
# boot of a fresh profile, so a second boot activates it. No-op until Zotero has
# created extensions.json. addon_id defaults to this add-on.
[private]
_approve-sideloaded-addon profile_dir addon_id="local-write-api@dzackgarza.com":
    #!/usr/bin/env python3
    import json, pathlib, sys
    p = pathlib.Path("{{profile_dir}}") / "extensions.json"
    if not p.is_file():
        sys.exit(f"{p} does not exist yet; boot Zotero on this profile once first")
    data = json.loads(p.read_text())
    hit = False
    for addon in data.get("addons", []):
        if addon.get("id") == "{{addon_id}}":
            addon["active"] = True
            addon["userDisabled"] = False
            addon["seen"] = True
            hit = True
    if not hit:
        sys.exit(f"{{addon_id}} not registered in {p}; did install-live copy the XPI?")
    p.write_text(json.dumps(data))
    print(f"approved {{addon_id}} in {p}")

# Static OpenAPI contract check (lint + generated-drift + dispatch conformance)
openapi-check:
    bun run openapi:check

# Generic Schemathesis fuzzing against a live Zotero.
# MUTATING: point ZOTERO_LOCAL_BASE_URL at a disposable test profile, never a
# real library. The filter_case hook excludes dangerous/networked/bulk ops.
[doc("Generic Schemathesis fuzz against a live Zotero (MUTATING: use a disposable profile)")]
schemathesis-fuzz-live:
    #!/usr/bin/env bash
    set -euo pipefail
    url="${ZOTERO_LOCAL_BASE_URL:-http://127.0.0.1:23119}"
    export PYTHONPATH="${PYTHONPATH:-}:."
    export SCHEMATHESIS_HOOKS="tests.schemathesis.hooks"
    # A fixed seed for a reproducible run, then a randomized exploration run.
    # Both emit JUnit + HAR reproduction artifacts. The stateful workflow runs
    # separately via schemathesis-stateful-live.
    for seed in "--seed 0" ""; do
        uv run st run openapi.yaml --url "$url" \
            --phases examples,coverage,fuzzing \
            ${seed} \
            --report junit,har --report-dir schemathesis-report
    done

# Live proof of the generated OpenAPI client wrapper (src/client.ts) against a
# real Zotero: real POST /write, body serialized unchanged, typed success/error
# split. MUTATING, so it is opt-in via ZOTERO_LIVE and is never collected by
# ordinary `bun test`; objects are uniquely prefixed and trashed afterwards.
[doc("Live proof of the generated TypeScript client wrapper (MUTATING, opt-in)")]
client-live:
    ZOTERO_LIVE=1 bun test tests/client-live.test.ts

# Stateful create/note/collection/tag/merge/restore/trash proof with Zotero
# read-back. Safe against a real library: unique-prefixed objects, cleanup in
# teardown. Skips when no live add-on is reachable.
[doc("Stateful create/merge/restore/trash workflow proof against a live Zotero")]
schemathesis-stateful-live:
    uv run pytest tests/schemathesis/test_stateful.py -q

# Full live API proof: generic fuzz, stateful workflow, client wrapper, smoke.
api-live: schemathesis-fuzz-live schemathesis-stateful-live client-live smoke-live

# Run all checks (typecheck + lint)
check: typecheck lint

# Release a patch version — bug fixes, infra, tooling (default)
release: (_release "patch")

# Release a minor version — new features or behaviour changes
release-minor: (_release "minor")

# Release a major version — breaking release line
release-major: (_release "major")

# Regenerate plugin icons via Replicate (requires REPLICATE_API_TOKEN in env)
# Run this, commit src/icons/, then cut a release.
[doc("Regenerate plugin icons via Replicate (requires REPLICATE_API_TOKEN)")]
gen-icons:
    #!/usr/bin/env python3
    import os, time, urllib.request, json
    from pathlib import Path

    token = os.environ.get("REPLICATE_API_TOKEN") or open(os.path.expanduser("~/.envrc")).read().split("REPLICATE_API_TOKEN=")[1].split("\n")[0]
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    prompt = (
        "minimal flat icon design, open book with a small electrical plug connector, "
        "dark red and white color scheme, clean geometric shapes, centered, no text, "
        "white background, icon style, vector-like"
    )
    payload = json.dumps({"input": {"prompt": prompt, "aspect_ratio": "1:1", "output_format": "png", "go_fast": True}}).encode()
    req = urllib.request.Request("https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions", data=payload, headers=headers, method="POST")
    pred_id = json.loads(urllib.request.urlopen(req).read())["id"]
    print(f"Prediction {pred_id} — waiting...")

    for _ in range(30):
        time.sleep(3)
        req = urllib.request.Request(f"https://api.replicate.com/v1/predictions/{pred_id}", headers=headers)
        resp = json.loads(urllib.request.urlopen(req).read())
        if resp["status"] == "succeeded":
            img_url = resp["output"][0]
            break
        elif resp["status"] == "failed":
            raise RuntimeError(f"Prediction failed: {resp}")
    else:
        raise TimeoutError("Timed out waiting for prediction")

    from PIL import Image
    import urllib.request as ul
    raw = Image.open(ul.urlopen(img_url)).convert("RGBA")
    icons = Path("src/icons")
    icons.mkdir(exist_ok=True)
    raw.resize((96, 96), Image.LANCZOS).save(icons / "favicon.png")
    raw.resize((48, 48), Image.LANCZOS).save(icons / "favicon@0.5x.png")
    print("Wrote src/icons/favicon.png (96x96) and src/icons/favicon@0.5x.png (48x48)")

# --- private ---

_bump bump_type:
    #!/usr/bin/env python3
    import re, sys
    from pathlib import Path
    path = Path("VERSION")
    source = path.read_text().strip()
    m = re.match(r'^(\d+)\.(\d+)\.(\d+)$', source)
    if not m:
        sys.exit('Could not parse X.Y.Z from VERSION')
    major, minor, patch = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if "{{bump_type}}" == "major":
        major, minor, patch = major + 1, 0, 0
    elif "{{bump_type}}" == "minor":
        minor, patch = minor + 1, 0
    else:
        patch += 1
    new = f"{major}.{minor}.{patch}"
    path.write_text(new + "\n")
    # openapi.yaml's info.version is served at /openapi.yaml and asserted equal
    # to VERSION by the contract test, so it must move in lockstep.
    spec = Path("openapi.yaml")
    spec_text = spec.read_text()
    spec_new, count = re.subn(
        r"^(  version: )'[^']*'", rf"\g<1>'{new}'", spec_text, count=1, flags=re.M
    )
    if count != 1:
        sys.exit("Could not find info.version in openapi.yaml to bump")
    spec.write_text(spec_new)
    print(f"Bumped to {new}")

_release bump_type: (_bump bump_type)
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Required before tagging: install the current working-tree XPI and run 'just smoke-live'" >&2
    bun run typecheck
    bun run lint
    uv run build.py
    version=$(cat VERSION)
    git add VERSION updates.json openapi.yaml src/generated/openapi.ts
    git commit -m "chore: release v${version}"
    git tag "v${version}"
    git push
    git push --tags
    echo "v${version} tagged — Actions will publish the release"

# --- GPT Action tunnel (see docs/gpt-action.md) ---

tunnel_name := "zotero-write"
tunnel_hostname := "zotero-write.dzackgarza.com"
tunnel_config := home_directory() / ".cloudflared/zotero-write.yml"
tunnel_unit := "zotero-write-tunnel.service"

# Fail loudly unless the LIVE write surface enforces a bearer token. The check
# lives in one tracked script so the systemd unit's ExecStartPre runs the same
# probe on every (re)start; see dev/cloudflared/require-write-token.sh.
_require-write-token:
    bash dev/cloudflared/require-write-token.sh

# Create the named tunnel, route DNS, and write ~/.cloudflared/zotero-write.yml
tunnel-setup: _require-write-token
    #!/usr/bin/env bash
    set -euo pipefail
    # The ingress path allowlist is the security boundary that keeps Zotero's
    # unauthenticated read API and connector off the public hostname. It must
    # equal the plugin's endpoint set (config.yml, the same source build.py
    # reads), so assert they match and fail loud on drift rather than letting a
    # new endpoint silently miss the tunnel or a widened regex leak the read API.
    config_paths=$(yq -r '.endpoints[]' config.yml | sed 's#^/##' | sort | paste -sd,)
    regex=$(yq -r '.ingress[0].path' dev/cloudflared/zotero-write.yml.template)
    alt=${regex#^/(}; alt=${alt%)$}
    ingress_paths=$(printf '%s\n' "${alt//|/$'\n'}" | sed 's#\\\.#.#g' | sort | paste -sd,)
    if [[ "$config_paths" != "$ingress_paths" ]]; then
        echo "Tunnel ingress paths are out of sync with config.yml endpoints:" >&2
        echo "  config.yml: $(echo "$config_paths" | paste -sd' ')" >&2
        echo "  template:   $(echo "$ingress_paths" | paste -sd' ')" >&2
        exit 1
    fi
    if ! cloudflared tunnel list --output json | jq -e --arg n "{{ tunnel_name }}" \
        'map(select(.name == $n)) | length > 0' > /dev/null; then
        cloudflared tunnel create "{{ tunnel_name }}"
    fi
    uuid=$(cloudflared tunnel list --output json | jq -r --arg n "{{ tunnel_name }}" \
        'map(select(.name == $n)) | .[0].id')
    cloudflared tunnel route dns "{{ tunnel_name }}" "{{ tunnel_hostname }}"
    sed -e "s|__TUNNEL_UUID__|${uuid}|g" -e "s|__HOME__|${HOME}|g" \
        dev/cloudflared/zotero-write.yml.template > "{{ tunnel_config }}"
    echo "Wrote {{ tunnel_config }} (tunnel ${uuid})"

# Install and start the systemd user unit that keeps the tunnel up
tunnel-install: _require-write-token
    mkdir -p ~/.config/systemd/user ~/.cloudflared
    # The unit's ExecStartPre runs this from a stable path, decoupled from the
    # repo checkout, so every start (including at boot) re-verifies auth.
    cp dev/cloudflared/require-write-token.sh ~/.cloudflared/require-write-token.sh
    chmod +x ~/.cloudflared/require-write-token.sh
    cp systemd/{{ tunnel_unit }} ~/.config/systemd/user/
    systemctl --user daemon-reload
    systemctl --user enable --now {{ tunnel_unit }}
    systemctl --user --no-pager status {{ tunnel_unit }}

tunnel-status:
    systemctl --user --no-pager status {{ tunnel_unit }}
    cloudflared tunnel info {{ tunnel_name }}

tunnel-logs:
    journalctl --user -u {{ tunnel_unit }} -f

tunnel-restart: _require-write-token
    systemctl --user restart {{ tunnel_unit }}

# Stop and disable the unit (the tunnel and DNS record survive)
tunnel-uninstall:
    systemctl --user disable --now {{ tunnel_unit }}
