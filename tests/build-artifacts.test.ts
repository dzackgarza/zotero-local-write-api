import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, Script } from "node:vm";
import "../src/bootstrap";

interface AddonManifest {
  name: string;
  version: string;
  homepage_url: string;
  applications: {
    zotero: {
      id: string;
      strict_min_version: string;
      strict_max_version: string;
      update_url: string;
    };
  };
}

interface UpdateEntry {
  version: string;
  update_link: string;
  update_hash: string;
  applications: {
    zotero: {
      strict_min_version: string;
      strict_max_version: string;
    };
  };
}

interface UpdatesManifest {
  addons: {
    "local-write-api@dzackgarza.com": {
      updates: [UpdateEntry];
    };
  };
}

function readJson<T>(path: string): T {
  let parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return parsed as T;
}

function runCommand(command: string[]): string {
  let result = Bun.spawnSync(command, {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed with exit ${result.exitCode}\n${new TextDecoder().decode(result.stdout)}\n${new TextDecoder().decode(result.stderr)}`,
    );
  }
  return new TextDecoder().decode(result.stdout);
}

let version = readFileSync("VERSION", "utf8").trim();
let xpiName = `local-write-api-${version}.xpi`;

// The tracked updates.json must keep the hash of the XPI uploaded to the
// GitHub release, so the manifest built from this dev tree goes to scratch.
let scratchDir = mkdtempSync(join(tmpdir(), "local-write-api-build-"));
let updatesOut = join(scratchDir, "updates.json");

beforeAll(() => {
  runCommand(["uv", "run", "build.py", "--updates-out", updatesOut]);
});

afterAll(() => {
  rmSync("src/bootstrap.js", { force: true });
  rmSync("src/manifest.json", { force: true });
  rmSync(xpiName, { force: true });
  rmSync(scratchDir, { recursive: true, force: true });
});

function readXpiManifest(): AddonManifest {
  return JSON.parse(runCommand(["unzip", "-p", xpiName, "manifest.json"])) as AddonManifest;
}

test("build packs the generated add-on manifest into the XPI", () => {
  expect(existsSync(xpiName)).toBe(true);
  expect(readXpiManifest()).toEqual(readJson<AddonManifest>("src/manifest.json"));
});

test("build emits an update manifest for the exact generated XPI", () => {
  let zotero = readXpiManifest().applications.zotero;
  let actualHash = createHash("sha256").update(readFileSync(xpiName)).digest("hex");
  let update =
    readJson<UpdatesManifest>(updatesOut).addons["local-write-api@dzackgarza.com"].updates[0];

  expect(update).toEqual({
    version,
    update_link: `https://github.com/dzackgarza/zotero-local-write-api/releases/download/v${version}/${xpiName}`,
    update_hash: `sha256:${actualHash}`,
    applications: {
      zotero: {
        strict_min_version: zotero.strict_min_version,
        strict_max_version: zotero.strict_max_version,
      },
    },
  });
});

// Zotero loads bootstrap.js as a classic script and calls the lifecycle
// functions that the script declares at top level. A classic script that
// contains an import or export statement does not compile.
test("the XPI's bootstrap.js is a classic script that declares the lifecycle functions", () => {
  let source = runCommand(["unzip", "-p", xpiName, "bootstrap.js"]);
  let scope = createContext({});
  new Script(source, { filename: "bootstrap.js" }).runInContext(scope);

  for (let name of ["install", "startup", "shutdown", "uninstall"]) {
    expect(typeof scope[name]).toBe("function");
  }
});
