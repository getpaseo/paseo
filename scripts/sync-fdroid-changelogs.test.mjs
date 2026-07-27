import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import androidVersionCodes from "../packages/app/android-version-codes.js";
import { formatFdroidChangelog, syncFdroidChangelogs } from "./sync-fdroid-changelogs.mjs";

const { getFdroidVersionCodes, getNativeBuildVersionCode } = androidVersionCodes;
const CHANGELOG_CHARACTER_LIMIT = 500;

function withTempRepo(fn, { changelog, version = "0.2.3" }) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "paseo-fdroid-changelogs-"));
  try {
    writeFileSync(path.join(tempDir, "package.json"), JSON.stringify({ version }));
    writeFileSync(path.join(tempDir, "CHANGELOG.md"), changelog);
    fn(tempDir);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
}

function readChangelogFile(dir, versionCode, locale = "en-US") {
  return readFileSync(
    path.join(dir, "fastlane", "metadata", "android", locale, "changelogs", `${versionCode}.txt`),
    "utf8",
  );
}

// The whole point of the shared module: these are the numbers the APKs actually
// ship with, so the filenames have to track them exactly.
test("derives one version code per published ABI", () => {
  assert.equal(getNativeBuildVersionCode("0.2.2"), 2002);
  assert.deepEqual(getFdroidVersionCodes("0.2.2"), [
    { abi: "armeabi-v7a", versionCode: 20021 },
    { abi: "arm64-v8a", versionCode: 20022 },
    { abi: "x86", versionCode: 20023 },
    { abi: "x86_64", versionCode: 20024 },
  ]);
});

test("ignores prerelease metadata when deriving version codes", () => {
  assert.equal(getNativeBuildVersionCode("0.2.3-beta.1"), getNativeBuildVersionCode("0.2.3"));
});

test("rejects versions that would collide or overflow", () => {
  assert.throws(() => getNativeBuildVersionCode("0.1000.0"), /collision-free/);
  assert.throws(() => getNativeBuildVersionCode("not-a-version"), /non-semver/);
  assert.throws(() => getNativeBuildVersionCode("210.0.0"), /ABI suffix/);
});

test("writes an identical changelog for every ABI version code", () => {
  const changelog = "# Changelog\n\n## 0.2.3 - 2026-07-27\n\n### Fixed\n\n- Something broke.\n";
  withTempRepo(
    (dir) => {
      const result = syncFdroidChangelogs([], { cwd: dir });

      assert.equal(result.written.length, 4);
      for (const { versionCode } of getFdroidVersionCodes("0.2.3")) {
        assert.equal(readChangelogFile(dir, versionCode), result.contents);
      }
      assert.match(result.contents, /- Something broke\./);
    },
    { changelog },
  );
});

test("strips PR references and contributor attributions", () => {
  const changelog = [
    "## 0.2.3 - 2026-07-27",
    "",
    "### Added",
    "",
    "- Support for `GitLab` merge requests ([#1913](https://x/1913) by [@nllptrx](https://y))",
    "",
  ].join("\n");

  withTempRepo(
    (dir) => {
      const { contents } = syncFdroidChangelogs([], { cwd: dir });
      assert.equal(contents.includes("#1913"), false);
      assert.equal(contents.includes("nllptrx"), false);
      assert.equal(contents.includes("`"), false);
      assert.match(contents, /- Support for GitLab merge requests\n/);
    },
    { changelog },
  );
});

test("stays inside the 500 character limit and keeps the full-notes link", () => {
  const bullets = Array.from(
    { length: 40 },
    (_, index) => `- Shipped improvement number ${index}.`,
  );
  const changelog = ["## 0.2.3 - 2026-07-27", "", "### Added", "", ...bullets, ""].join("\n");

  withTempRepo(
    (dir) => {
      const { contents } = syncFdroidChangelogs([], { cwd: dir });
      assert.ok(
        contents.length <= CHANGELOG_CHARACTER_LIMIT,
        `expected <= ${CHANGELOG_CHARACTER_LIMIT}, got ${contents.length}`,
      );
      assert.match(contents, /Full notes: https:\/\/paseo\.sh\/changelog\n$/);
      // Truncation happens at a bullet boundary, never mid-sentence.
      assert.equal(contents.includes("Shipped improvement number 0."), true);
      assert.equal(/- Shipped improvement number \d+\.\.\.$/m.test(contents), false);
    },
    { changelog },
  );
});

test("never leaves an orphan section heading when bullets get cut", () => {
  const filler = Array.from({ length: 20 }, (_, index) => `- Improvement ${index} with some text.`);
  const changelog = [
    "## 0.2.3 - 2026-07-27",
    "",
    "### Improved",
    "",
    ...filler,
    "",
    "### Fixed",
    "",
    "- A late fix that will not fit.",
    "",
  ].join("\n");

  withTempRepo(
    (dir) => {
      const { contents } = syncFdroidChangelogs([], { cwd: dir });
      assert.equal(contents.includes("Fixed"), false);
      assert.equal(contents.trimEnd().endsWith("Improved"), false);
    },
    { changelog },
  );
});

test("salvages a truncated first bullet rather than emitting only a link", () => {
  const contents = formatFdroidChangelog(["### Added", `- ${"x".repeat(600)}`]);
  assert.ok(contents.length <= CHANGELOG_CHARACTER_LIMIT);
  assert.match(contents, /^- x+\.\.\.\n\nFull notes:/);
});

test("--check fails when the generated files are missing or stale", () => {
  const changelog = "## 0.2.3 - 2026-07-27\n\n### Fixed\n\n- Something broke.\n";
  withTempRepo(
    (dir) => {
      assert.throws(() => syncFdroidChangelogs(["--check"], { cwd: dir }), /out of date/);

      syncFdroidChangelogs([], { cwd: dir });
      assert.doesNotThrow(() => syncFdroidChangelogs(["--check"], { cwd: dir }));

      const [{ versionCode }] = getFdroidVersionCodes("0.2.3");
      writeFileSync(
        path.join(
          dir,
          "fastlane",
          "metadata",
          "android",
          "en-US",
          "changelogs",
          `${versionCode}.txt`,
        ),
        "drifted\n",
      );
      assert.throws(() => syncFdroidChangelogs(["--check"], { cwd: dir }), /out of date/);
    },
    { changelog },
  );
});

test("fails loudly when the release has no changelog entry", () => {
  const changelog = "## 0.2.2 - 2026-07-25\n\n### Fixed\n\n- Older release.\n";
  withTempRepo(
    (dir) => {
      assert.throws(() => syncFdroidChangelogs([], { cwd: dir }), /No CHANGELOG\.md entry/);
    },
    { changelog, version: "0.2.3" },
  );
});

test("honours a non-default locale directory", () => {
  const changelog = "## 0.2.3 - 2026-07-27\n\n### Fixed\n\n- Something broke.\n";
  withTempRepo(
    (dir) => {
      mkdirSync(path.join(dir, "fastlane", "metadata", "android", "ja"), { recursive: true });
      syncFdroidChangelogs(["--locale", "ja"], { cwd: dir });
      const [{ versionCode }] = getFdroidVersionCodes("0.2.3");
      assert.match(readChangelogFile(dir, versionCode, "ja"), /- Something broke\./);
    },
    { changelog },
  );
});
