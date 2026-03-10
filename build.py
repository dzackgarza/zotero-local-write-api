#!/usr/bin/env python3
from __future__ import annotations

"""Build release artifacts for the Zotero Local Write API plugin."""

import hashlib
import json
import re
import zipfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
BOOTSTRAP_PATH = SRC / "bootstrap.js"
ICONS_DIR = SRC / "icons"
UPDATES_PATH = ROOT / "updates.json"

cfg = yaml.safe_load((ROOT / "config.yml").read_text())
VERSION = (ROOT / "VERSION").read_text().strip()

ADDON_ID = cfg["addon"]["id"]
ADDON_SLUG = cfg["addon"]["slug"]
ADDON_NAME = cfg["addon"]["name"]
ADDON_AUTHOR = cfg["addon"]["author"]
ADDON_DESCRIPTION = cfg["addon"]["description"]

REPO_OWNER = cfg["repo"]["owner"]
REPO_NAME = cfg["repo"]["name"]
REPO_BRANCH = cfg["repo"]["branch"]
REPO_URL = f"https://github.com/{REPO_OWNER}/{REPO_NAME}"

STRICT_MIN_VERSION = cfg["zotero"]["strict_min_version"]
STRICT_MAX_VERSION = cfg["zotero"]["strict_max_version"]
TESTED_ZOTERO_VERSION = cfg["zotero"]["tested_version"]

ATTACH_PATH = cfg["endpoints"]["attach"]
WRITE_PATH = cfg["endpoints"]["write"]
VERSION_PATH = cfg["endpoints"]["version"]

UPDATE_MANIFEST_URL = (
    f"https://raw.githubusercontent.com/{REPO_OWNER}/{REPO_NAME}/{REPO_BRANCH}/updates.json"
)
XPI_FILENAME = f"{ADDON_SLUG}-{VERSION}.xpi"
XPI_URL = f"https://github.com/{REPO_OWNER}/{REPO_NAME}/releases/download/v{VERSION}/{XPI_FILENAME}"

BOOTSTRAP_VAR_PATTERNS = {
    "PLUGIN_VERSION": re.compile(r"var PLUGIN_VERSION = .*?;"),
    "FULLTEXT_ATTACH_PATH": re.compile(r"var FULLTEXT_ATTACH_PATH = .*?;"),
    "LOCAL_WRITE_PATH": re.compile(r"var LOCAL_WRITE_PATH = .*?;"),
    "VERSION_PATH": re.compile(r"var VERSION_PATH = .*?;"),
    "ADDON_ID": re.compile(r"var ADDON_ID = .*?;"),
    "HOMEPAGE_URL": re.compile(r"var HOMEPAGE_URL = .*?;"),
    "UPDATE_URL": re.compile(r"var UPDATE_URL = .*?;"),
    "STRICT_MIN_VERSION": re.compile(r"var STRICT_MIN_VERSION = .*?;"),
    "STRICT_MAX_VERSION": re.compile(r"var STRICT_MAX_VERSION = .*?;"),
    "TESTED_ZOTERO_VERSION": re.compile(r"var TESTED_ZOTERO_VERSION = .*?;"),
}
BOOTSTRAP_VAR_VALUES = {
    "PLUGIN_VERSION": VERSION,
    "FULLTEXT_ATTACH_PATH": ATTACH_PATH,
    "LOCAL_WRITE_PATH": WRITE_PATH,
    "VERSION_PATH": VERSION_PATH,
    "ADDON_ID": ADDON_ID,
    "HOMEPAGE_URL": REPO_URL,
    "UPDATE_URL": UPDATE_MANIFEST_URL,
    "STRICT_MIN_VERSION": STRICT_MIN_VERSION,
    "STRICT_MAX_VERSION": STRICT_MAX_VERSION,
    "TESTED_ZOTERO_VERSION": TESTED_ZOTERO_VERSION,
}


def write_json(path: Path, payload: dict[str, object]) -> None:
    path.write_text(f"{json.dumps(payload, indent=2, sort_keys=True)}\n")


def update_bootstrap_metadata() -> None:
    source = BOOTSTRAP_PATH.read_text()
    for var, pattern in BOOTSTRAP_VAR_PATTERNS.items():
        source, n = pattern.subn(
            f"var {var} = {json.dumps(BOOTSTRAP_VAR_VALUES[var])};",
            source,
            count=1,
        )
        if n != 1:
            raise RuntimeError(f"Could not update {var} in bootstrap.js")
    BOOTSTRAP_PATH.write_text(source)


def build_manifest() -> dict[str, object]:
    return {
        "manifest_version": 2,
        "name": ADDON_NAME,
        "version": VERSION,
        "description": ADDON_DESCRIPTION,
        "author": ADDON_AUTHOR,
        "homepage_url": REPO_URL,
        "icons": {"48": "icons/favicon@0.5x.png", "96": "icons/favicon.png"},
        "applications": {
            "zotero": {
                "id": ADDON_ID,
                "strict_min_version": STRICT_MIN_VERSION,
                "strict_max_version": STRICT_MAX_VERSION,
                "update_url": UPDATE_MANIFEST_URL,
            }
        },
    }


_EPOCH = (2020, 1, 1, 0, 0, 0)  # fixed timestamp for deterministic builds


def _zip_entry(arcname: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(arcname, date_time=_EPOCH)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 0
    return info


def build_xpi() -> Path:
    manifest_path = SRC / "manifest.json"
    xpi_path = ROOT / XPI_FILENAME
    with zipfile.ZipFile(xpi_path, "w", zipfile.ZIP_DEFLATED) as xpi:
        xpi.writestr(_zip_entry("manifest.json"), manifest_path.read_bytes())
        xpi.writestr(_zip_entry("bootstrap.js"), BOOTSTRAP_PATH.read_bytes())
        if ICONS_DIR.is_dir():
            for icon in sorted(ICONS_DIR.iterdir()):
                if icon.is_file():
                    xpi.writestr(_zip_entry(f"icons/{icon.name}"), icon.read_bytes())
    return xpi_path


def sha256sum(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_updates_manifest(xpi_hash: str) -> dict[str, object]:
    return {
        "addons": {
            ADDON_ID: {
                "updates": [
                    {
                        "version": VERSION,
                        "update_link": XPI_URL,
                        "update_hash": f"sha256:{xpi_hash}",
                        "applications": {
                            "zotero": {
                                "strict_min_version": STRICT_MIN_VERSION,
                                "strict_max_version": STRICT_MAX_VERSION,
                            }
                        },
                    }
                ]
            }
        }
    }


def remove_old_xpis() -> None:
    for old_xpi in ROOT.glob("*.xpi"):
        old_xpi.unlink()


def build() -> Path:
    print(f"Building {ADDON_NAME} v{VERSION}")
    print(f"Zotero compatibility: {STRICT_MIN_VERSION} – {STRICT_MAX_VERSION}")
    print(f"Tested target: Zotero {TESTED_ZOTERO_VERSION}")

    update_bootstrap_metadata()
    manifest = build_manifest()
    write_json(SRC / "manifest.json", manifest)
    remove_old_xpis()
    xpi_path = build_xpi()
    write_json(UPDATES_PATH, build_updates_manifest(sha256sum(xpi_path)))

    print(f"Wrote updates.json")
    print(f"Built {xpi_path.name}")
    print(f"Update manifest URL: {UPDATE_MANIFEST_URL}")
    print(f"XPI URL: {XPI_URL}")
    return xpi_path


if __name__ == "__main__":
    build()
