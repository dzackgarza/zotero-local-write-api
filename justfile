# Show the current version
version:
    @cat VERSION

# Type-check the TypeScript source
typecheck:
    bun tsc --noEmit

# Lint the TypeScript source
lint:
    bun run lint

# Compile TypeScript and build the XPI (does not bump version or release)
build:
    python3 build.py

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
    python3 examples/live_smoke.py "${args[@]}"

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
    print(f"Bumped to {new}")

_release bump_type: (_bump bump_type)
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Required before tagging: install the current working-tree XPI and run 'just smoke-live'" >&2
    bun run typecheck
    bun run lint
    python3 build.py
    version=$(cat VERSION)
    git add VERSION updates.json
    git commit -m "chore: release v${version}"
    git tag "v${version}"
    git push
    git push --tags
    echo "v${version} tagged — Actions will publish the release"
