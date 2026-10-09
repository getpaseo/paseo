import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { validateDesktopManifests } from "./validate-desktop-manifests.mjs";

const releaseDate = "2026-09-04T00:00:00.000Z";
const scriptPath = fileURLToPath(new URL("./validate-desktop-manifests.mjs", import.meta.url));

function withManifest(contents, run) {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-validate-desktop-manifest-"));
  const manifestPath = path.join(dir, "latest-mac.yml");
  try {
    writeFileSync(manifestPath, contents);
    run(manifestPath);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

test("accepts a guarded macOS update manifest", () => {
  withManifest(
    `version: 0.7.3\nreleaseDate: '${releaseDate}'\nrolloutHours: 36\nminimumSystemVersion: 22.0.0\n`,
    (manifestPath) => {
      validateDesktopManifests({ releaseDate, rolloutHours: 36 }, [manifestPath]);
    },
  );
});

test("validates release manifests through the workflow CLI", () => {
  withManifest(
    `version: 0.7.3\nreleaseDate: '${releaseDate}'\nrolloutHours: 36\nminimumSystemVersion: 22.0.0\n`,
    (manifestPath) => {
      const result = spawnSync(
        process.execPath,
        [scriptPath, "--release-date", releaseDate, "--rollout-hours", "36", manifestPath],
        { encoding: "utf8" },
      );

      assert.equal(result.status, 0, result.stderr);
    },
  );
});

test("rejects a macOS update manifest without the system floor", () => {
  withManifest(
    `version: 0.7.3\nreleaseDate: '${releaseDate}'\nrolloutHours: 36\n`,
    (manifestPath) => {
      assert.throws(
        () => validateDesktopManifests({ releaseDate, rolloutHours: 36 }, [manifestPath]),
        /minimumSystemVersion=undefined, expected 22\.0\.0/,
      );
    },
  );
});

test("rejects invalid rollout metadata", () => {
  withManifest(
    `version: 0.7.3\nreleaseDate: '${releaseDate}'\nrolloutHours: 24\nminimumSystemVersion: 22.0.0\n`,
    (manifestPath) => {
      assert.throws(
        () => validateDesktopManifests({ releaseDate, rolloutHours: 36 }, [manifestPath]),
        /rolloutHours=24, expected 36/,
      );
    },
  );
});
