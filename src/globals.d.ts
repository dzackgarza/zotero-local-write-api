// APP_SHUTDOWN is a Zotero bootstrap constant not in zotero-types
declare let APP_SHUTDOWN: number;

// Build-time constants, injected by build.py via esbuild --define from
// config.yml and VERSION (the single sources). They are ambient free
// identifiers with no `let` binding: esbuild's define only substitutes free
// identifiers, so a `let X = "default"` declaration silently defeated every
// define and shipped the source defaults (e.g. /version reported "3.2.0-dev"
// forever). All references are inside functions, never at module scope, so the
// unbuilt module still type-checks and loads.
declare const PLUGIN_VERSION: string;
declare const FULLTEXT_ATTACH_PATH: string;
declare const LOCAL_WRITE_PATH: string;
declare const VERSION_PATH: string;
declare const OPENAPI_PATH: string;
declare const FULLTEXT_ALLOWED_DIRS: string[];
declare const EXTERNAL_SERVICE_CANDIDATE_LIMIT: number;
declare const ADDON_ID: string;
declare const HOMEPAGE_URL: string;
declare const UPDATE_URL: string;
declare const STRICT_MIN_VERSION: string;
declare const STRICT_MAX_VERSION: string;
declare const TESTED_ZOTERO_VERSION: string;
