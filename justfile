plugin_dir := "fulltext-attach-plugin"

# Show the current version
version:
    @cd {{plugin_dir}} && python3 -c "from version import VERSION; print(VERSION)"

# Regenerate manifest.json, updates.json, and local .xpi from version.py
build:
    cd {{plugin_dir}} && python3 build.py

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
