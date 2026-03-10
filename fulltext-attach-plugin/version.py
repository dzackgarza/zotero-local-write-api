#!/usr/bin/env python3
"""Canonical release metadata for the Zotero attachment plugin."""

VERSION = "3.2"

REPO_OWNER = "dzackgarza"
REPO_NAME = "zotero-attachment-plugin"
REPO_BRANCH = "main"

ADDON_ID = "fulltext-attach-api-v3@local.dev"
ADDON_SLUG = "fulltext-attach-plugin"
ADDON_NAME = "Fulltext Attachment API"
ADDON_DESCRIPTION = (
    "Provides local HTTP endpoints for Zotero attachments and OpenCode item writes."
)

STRICT_MIN_VERSION = "7.0"
STRICT_MAX_VERSION = "8.0.*"
TESTED_ZOTERO_VERSION = "8.0.1"

FULLTEXT_ATTACH_PATH = "/fulltext-attach"
LOCAL_WRITE_PATH = "/opencode-zotero-write"
VERSION_PATH = "/opencode-zotero-plugin-version"

REPO_URL = f"https://github.com/{REPO_OWNER}/{REPO_NAME}"
RAW_BASE_URL = (
    f"https://raw.githubusercontent.com/{REPO_OWNER}/{REPO_NAME}/{REPO_BRANCH}/{ADDON_SLUG}"
)
UPDATE_MANIFEST_FILENAME = "updates.json"
UPDATE_MANIFEST_URL = f"{RAW_BASE_URL}/{UPDATE_MANIFEST_FILENAME}"
XPI_FILENAME = f"{ADDON_SLUG}-{VERSION}.xpi"
XPI_URL = f"https://github.com/{REPO_OWNER}/{REPO_NAME}/releases/download/v{VERSION}/{XPI_FILENAME}"
