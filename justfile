plugin_dir := "fulltext-attach-plugin"

# Show the current version
version:
    @cd {{plugin_dir}} && python3 -c "from version import VERSION; print(VERSION)"

# Regenerate manifest.json, updates.json, and local .xpi from version.py
build:
    cd {{plugin_dir}} && python3 build.py

# Generate plugin icons via Replicate (requires REPLICATE_API_TOKEN in env)
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
    icons = Path("{{plugin_dir}}/icons")
    icons.mkdir(exist_ok=True)
    raw.resize((96, 96), Image.LANCZOS).save(icons / "favicon.png")
    raw.resize((48, 48), Image.LANCZOS).save(icons / "favicon@0.5x.png")
    print("Wrote icons/favicon.png (96x96) and icons/favicon@0.5x.png (48x48)")

# Bump version.py in-place
_bump bump_type:
    #!/usr/bin/env python3
    import re, sys
    from pathlib import Path
    path = Path("{{plugin_dir}}/version.py")
    source = path.read_text()
    m = re.search(r'^VERSION = "(\d+)\.(\d+)\.(\d+)"$', source, re.MULTILINE)
    if not m:
        sys.exit('Could not parse VERSION = "X.Y.Z" from version.py')
    major, minor, patch = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if "{{bump_type}}" == "major":
        major, minor, patch = major + 1, 0, 0
    elif "{{bump_type}}" == "minor":
        minor, patch = minor + 1, 0
    else:
        patch += 1
    new = f"{major}.{minor}.{patch}"
    path.write_text(re.sub(r'^VERSION = ".*"$', f'VERSION = "{new}"', source, flags=re.MULTILINE))
    print(f"Bumped to {new}")

# Build, commit metadata, push, and create a GitHub Release
_release bump_type: (_bump bump_type)
    #!/usr/bin/env bash
    set -euo pipefail
    cd {{plugin_dir}}
    python3 build.py
    version=$(python3 -c "from version import VERSION; print(VERSION)")
    xpi="fulltext-attach-plugin-${version}.xpi"
    cd ..
    git add {{plugin_dir}}/version.py {{plugin_dir}}/manifest.json {{plugin_dir}}/updates.json
    git commit -m "chore: release v${version}"
    git push
    gh release create "v${version}" \
        --title "v${version}" \
        --generate-notes \
        "{{plugin_dir}}/${xpi}#Zotero add-on (.xpi)"
    echo "Released v${version}: https://github.com/dzackgarza/zotero-attachment-plugin/releases/tag/v${version}"

# Release a patch version — bug fixes, infra, tooling (default)
release: (_release "patch")

# Release a minor version — new features or behaviour changes
release-minor: (_release "minor")

# Release a major version — breaking release line
release-major: (_release "major")
