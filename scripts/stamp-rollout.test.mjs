import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { stampRollout } from "./stamp-rollout.mjs";

test("rewrites rollout fields and preserves unrelated manifest data", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-stamp-rollout-"));
  try {
    const firstPath = path.join(dir, "latest.yml");
    const secondPath = path.join(dir, "latest-mac.yml");
    writeFileSync(
      firstPath,
      "version: 1.2.3\nfiles:\n  - url: app.zip\n    sha512: abc\nreleaseDate: '2026-04-28T00:00:00.000Z'\nrolloutHours: 24\nstagingPercentage: 25\n",
    );
    writeFileSync(
      secondPath,
      "version: 1.2.3\nfiles:\n  - url: app-arm64.zip\n    sha512: def\nreleaseDate: '2026-04-28T00:00:00.000Z'\npath: app-arm64.zip\n",
    );
    stampRollout({ releaseDate: "2026-05-01T12:00:00.000Z", rolloutHours: 6 }, [
      firstPath,
      secondPath,
    ]);

    const first = readFileSync(firstPath, "utf8");
    const second = readFileSync(secondPath, "utf8");

    assert.match(first, /releaseDate: '2026-05-01T12:00:00.000Z'/);
    assert.match(first, /rolloutHours: 6/);
    assert.match(first, /stagingPercentage: 25/);
    assert.match(second, /releaseDate: '2026-05-01T12:00:00.000Z'/);
    assert.match(second, /rolloutHours: 6/);
    assert.match(second, /path: app-arm64\.zip/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("only updates rolloutHours when releaseDate is omitted", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-stamp-rollout-"));
  try {
    const filePath = path.join(dir, "latest.yml");
    writeFileSync(
      filePath,
      "version: 1.2.3\nfiles:\n  - url: app.zip\n    sha512: abc\nreleaseDate: '2026-04-28T00:00:00.000Z'\nrolloutHours: 24\nstagingPercentage: 25\n",
    );
    stampRollout({ rolloutHours: 0 }, [filePath]);

    const out = readFileSync(filePath, "utf8");
    assert.match(out, /releaseDate: '2026-04-28T00:00:00.000Z'/);
    assert.match(out, /rolloutHours: 0/);
    assert.match(out, /stagingPercentage: 25/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("throws when neither releaseDate nor rolloutHours is provided", () => {
  assert.throws(() => stampRollout({}, ["/tmp/does-not-matter.yml"]));
});
