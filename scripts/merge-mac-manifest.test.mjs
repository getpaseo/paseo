import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { mergeMacManifest } from "./merge-mac-manifest.mjs";

test("preserves unknown fields while merging files by url", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-merge-mac-manifest-"));
  try {
    const arm64Path = path.join(dir, "arm64.yml");
    const x64Path = path.join(dir, "x64.yml");
    const outputPath = path.join(dir, "latest-mac.yml");
    writeFileSync(
      arm64Path,
      "version: 1.2.3\nfiles:\n  - url: app-arm64.zip\n    sha512: arm\nstagingPercentage: 25\npath: app-arm64.zip\nsha512: arm\nreleaseDate: '2026-04-28T00:00:00.000Z'\n",
    );
    writeFileSync(
      x64Path,
      "version: 1.2.3\nfiles:\n  - url: app-x64.zip\n    sha512: x64\nstagingPercentage: 50\npath: app-x64.zip\nsha512: x64\nreleaseDate: '2026-04-29T00:00:00.000Z'\n",
    );
    mergeMacManifest(arm64Path, x64Path, outputPath);
    const output = readFileSync(outputPath, "utf8");
    assert.match(output, /stagingPercentage: 25/);
    assert.match(output, /url: app-arm64\.zip/);
    assert.match(output, /url: app-x64\.zip/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
