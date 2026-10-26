import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
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

test("build emits an update manifest for the exact generated XPI", () => {
  let version = readFileSync("VERSION", "utf8").trim();
  let xpiName = `local-write-api-${version}.xpi`;

  runCommand(["python3", "build.py"]);

  try {
    expect(existsSync(xpiName)).toBe(true);

    let manifestFromSource = readJson<AddonManifest>("src/manifest.json");
    let manifestFromXpi = JSON.parse(
      runCommand(["unzip", "-p", xpiName, "manifest.json"]),
    ) as AddonManifest;
    expect(manifestFromXpi).toEqual(manifestFromSource);

    let actualHash = createHash("sha256").update(readFileSync(xpiName)).digest("hex");
    let update =
      readJson<UpdatesManifest>("updates.json").addons["local-write-api@dzackgarza.com"].updates[0];

    expect(update).toEqual({
      version,
      update_link: `https://github.com/dzackgarza/zotero-local-write-api/releases/download/v${version}/${xpiName}`,
      update_hash: `sha256:${actualHash}`,
      applications: {
        zotero: {
          strict_min_version: manifestFromXpi.applications.zotero.strict_min_version,
          strict_max_version: manifestFromXpi.applications.zotero.strict_max_version,
        },
      },
    });
  } finally {
    rmSync("src/bootstrap.js", { force: true });
    rmSync("src/manifest.json", { force: true });
    rmSync(xpiName, { force: true });
  }
});
