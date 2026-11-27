qc-type := "bun"

ai_review_ci_schema_version := "1"
ai_review_ci_profile := "bun"
ai_review_ci_ref := "main"
ai_review_ci_release_channel := "main"
ai_review_ci_workflow_template_version := "1"
ai_review_ci_local_delegation := "global-justfile"
ai_review_ci_default_branch := "main"

[doc("Validate supported staged file syntax through shared QC")]
test-commit:
    @just -f ~/ai-review-ci/justfiles/bun.just -d . test-commit

[doc("Validate supported outgoing file syntax through shared QC")]
test-push:
    @just -f ~/ai-review-ci/justfiles/bun.just -d . test-push

[doc("Run shared CI diagnostics including Bun tests, Biome and ESLint")]
test-ci:
    @just -f ~/ai-review-ci/justfiles/bun.just -d . test-ci

[doc("Show the current version")]
version:
    @cat VERSION

[doc("Type-check the TypeScript source")]
typecheck:
    bun tsc --noEmit

[doc("Compile TypeScript and build the XPI (does not bump version or release).")]
build:
    uv run build.py --updates-out "$(mktemp -d)/updates.json"

[doc("Live runtime proof against a real Zotero with the current XPI installed.")]
smoke-live:
    #!/usr/bin/env bash
    set -euo pipefail
    args=(--expected-version "${EXPECTED_VERSION:?set EXPECTED_VERSION to the installed add-on version, the VERSION file for a working-tree build}")
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

[doc("Build, install, and restart Zotero so the working-tree XPI is live (RESTARTS Zotero)")]
install-live:
    #!/usr/bin/env bash
    set -euo pipefail
    version="$(cat VERSION)"
    xpi="local-write-api-${version}.xpi"

    uv run build.py --updates-out "$(mktemp -d)/updates.json"
    if [[ ! -f "$xpi" ]]; then
        echo "expected $xpi was not built" >&2
        exit 1
    fi

    profile_dir="${ZOTERO_PROFILE_DIR:-$(just _default-profile-dir)}"
    if [[ ! -d "$profile_dir" ]]; then
        echo "profile dir not found: $profile_dir" >&2
        exit 1
    fi
    ext_dir="${profile_dir}/extensions"
    installed="${ext_dir}/local-write-api@dzackgarza.com.xpi"

    if [[ -f "$installed" ]]; then
        cp -p "$installed" "${installed}.bak.$(date +%Y%m%d-%H%M%S)"
    fi

    mkdir -p "$ext_dir"
    cp "$xpi" "$installed"
    if [[ "$(sha256sum "$xpi" | cut -d' ' -f1)" != "$(sha256sum "$installed" | cut -d' ' -f1)" ]]; then
        echo "sha256 mismatch after install" >&2
        exit 1
    fi
    echo "installed $xpi -> $installed"

    if pgrep -x zotero-bin > /dev/null; then pkill -x zotero-bin; fi
    for _ in $(seq 1 30); do
        if ! pgrep -x 'zotero(-bin)?' > /dev/null; then break; fi
        sleep 1
    done
    if pgrep -x 'zotero(-bin)?' > /dev/null; then
        echo "Zotero did not exit within 30 s" >&2
        exit 1
    fi
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
    required = {"attach", "attach_bytes", "attach_standalone", "import_store_attachments", "recognition_held_from_sync", "write", "version_probe", "import_bibtex"}
    missing = required - set(v.get("capabilities") or [])
    if missing:
        sys.exit(f"add-on is missing capabilities: {sorted(missing)}")
    if v.get("translators_ready") is not True:
        sys.exit(1)
    ' "$probe" "$version"; then
                echo "Zotero up with version $version — run 'EXPECTED_VERSION=$version just smoke-live' to prove behavior"
                exit 0
            fi
        fi
        sleep 2
    done
    echo "Zotero did not report version $version within timeout; see $log" >&2
    exit 1

[doc("Path of the active (Default=1) Zotero profile directory.")]
[private]
_default-profile-dir:
    #!/usr/bin/env python3
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

[doc("Provision (idempotently) a disposable Zotero profile + empty data directory for the mutating fuzz, and print `NAME<TAB>DIR<TAB>DATADIR`.")]
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
    cfg[section].pop("Default", None)
    with open(ini, "w") as f:
        cfg.write(f, space_around_delimiters=False)

    (profile_dir / "prefs.js").write_text(
        f'user_pref("extensions.zotero.dataDir", "{data_dir}");\n'
        'user_pref("extensions.zotero.useDataDir", true);\n'
        'user_pref("extensions.zotero.httpServer.enabled", true);\n'
        'user_pref("extensions.zotero.httpServer.localAPI.enabled", true);\n'
        'user_pref("extensions.zotero.firstRun2", false);\n'
        'user_pref("extensions.zotero.firstRun.skipFirefoxProfileAccessCheck", true);\n'
    )
    print(f"{name}\t{profile_dir}\t{data_dir}")

[doc("Approve the add-on that Zotero registered as a disabled sideload on first boot of a fresh profile, so a second boot activates it.")]
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

[doc("Static OpenAPI contract check (lint + generated-drift + dispatch conformance)")]
openapi-check:
    bun run openapi:check

[doc("Generic Schemathesis fuzz against a live Zotero (MUTATING: use a disposable profile)")]
schemathesis-fuzz-live:
    #!/usr/bin/env bash
    set -euo pipefail
    url="${ZOTERO_LOCAL_BASE_URL:-http://127.0.0.1:23119}"
    export PYTHONPATH="${PYTHONPATH:-}:."
    export SCHEMATHESIS_HOOKS="tests.schemathesis.hooks"
    for seed in "--seed 0" ""; do
        uv run st run openapi.yaml --url "$url" \
            --phases examples,coverage,fuzzing \
            ${seed} \
            --report junit,har --report-dir schemathesis-report
    done

[doc("Live proof of the generated TypeScript client wrapper (MUTATING)")]
client-live:
    ZOTERO_LOCAL_BASE_URL="${ZOTERO_LOCAL_BASE_URL:-http://127.0.0.1:23119}" \
    ZOTERO_LIBRARY_ID="${ZOTERO_LIBRARY_ID:-0}" \
    bun run client:live

[doc("Live proof of import_from_url and resolve_url (MUTATING)")]
import-from-url-live:
    ZOTERO_LOCAL_BASE_URL="${ZOTERO_LOCAL_BASE_URL:-http://127.0.0.1:23119}" \
    ZOTERO_LIBRARY_ID="${ZOTERO_LIBRARY_ID:-0}" \
    bun run import-from-url:live

[doc("Live proof of find_items_by_title and get_item_children (MUTATING)")]
item-lookup-live:
    ZOTERO_LOCAL_BASE_URL="${ZOTERO_LOCAL_BASE_URL:-http://127.0.0.1:23119}" \
    ZOTERO_LIBRARY_ID="${ZOTERO_LIBRARY_ID:-0}" \
    bun run item-lookup:live

[doc("Stateful create/merge/restore/trash workflow proof against a live Zotero")]
schemathesis-stateful-live:
    uv run pytest tests/schemathesis/test_stateful.py -q

[doc("Full live API proof: generic fuzz, stateful workflow, client wrapper, lookups, smoke.")]
api-live: schemathesis-fuzz-live schemathesis-stateful-live client-live item-lookup-live smoke-live

[doc("Type-check the TypeScript source and run staged syntax validation")]
check: typecheck test-commit

[doc("Release a patch version — bug fixes, infra, tooling (default)")]
release: (_release "patch")

[doc("Release a minor version — new features or behaviour changes")]
release-minor: (_release "minor")

[doc("Release a major version — breaking release line")]
release-major: (_release "major")

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

[private]
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
    spec = Path("openapi.yaml")
    spec_text = spec.read_text()
    spec_new, count = re.subn(
        r"^(  version: )'[^']*'", rf"\g<1>'{new}'", spec_text, count=1, flags=re.M
    )
    if count != 1:
        sys.exit("Could not find info.version in openapi.yaml to bump")
    spec.write_text(spec_new)
    print(f"Bumped to {new}")

[private]
_release bump_type: (_bump bump_type)
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Required before tagging: install the current working-tree XPI and run 'EXPECTED_VERSION=\$(cat VERSION) just smoke-live'" >&2
    bun run typecheck
    just test-commit
    uv run build.py
    version=$(cat VERSION)
    git add VERSION updates.json openapi.yaml src/generated/openapi.ts
    git commit -m "chore: release v${version}"
    git tag "v${version}"
    git push
    git push --tags
    echo "v${version} tagged — Actions will publish the release"

tunnel_name := "zotero-write"
tunnel_hostname := "zotero-write.dzackgarza.com"
tunnel_config := home_directory() / ".cloudflared/zotero-write.yml"
tunnel_unit := "zotero-write-tunnel.service"

[doc("Fail loudly unless the LIVE write surface enforces a bearer token.")]
_require-write-token:
    bash dev/cloudflared/require-write-token.sh

[doc("Create the named tunnel, route DNS, and write ~/.cloudflared/zotero-write.yml")]
tunnel-setup: _require-write-token
    #!/usr/bin/env bash
    set -euo pipefail
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

[doc("Install and start the systemd user unit that keeps the tunnel up")]
tunnel-install: _require-write-token
    mkdir -p ~/.config/systemd/user ~/.cloudflared
    cp dev/cloudflared/require-write-token.sh ~/.cloudflared/require-write-token.sh
    chmod +x ~/.cloudflared/require-write-token.sh
    cp systemd/{{ tunnel_unit }} ~/.config/systemd/user/
    systemctl --user daemon-reload
    systemctl --user enable --now {{ tunnel_unit }}
    systemctl --user --no-pager status {{ tunnel_unit }}

[doc("Show the tunnel unit status and tunnel info")]
tunnel-status:
    systemctl --user --no-pager status {{ tunnel_unit }}
    cloudflared tunnel info {{ tunnel_name }}

[doc("Follow the tunnel unit logs")]
tunnel-logs:
    journalctl --user -u {{ tunnel_unit }} -f

[doc("Restart the tunnel unit")]
tunnel-restart: _require-write-token
    systemctl --user restart {{ tunnel_unit }}

[doc("Stop and disable the unit (the tunnel and DNS record survive)")]
tunnel-uninstall:
    systemctl --user disable --now {{ tunnel_unit }}
