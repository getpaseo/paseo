import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { mergeChangelogEntry, reconcileRelease } from "./reconcile-release.mjs";

const MAIN_CHANGELOG_WITH_BETA = `# Changelog

## 0.17.0-beta.1 - 2026-11-19

- **Beta 1 highlight:** Initial beta. ([#101](https://github.com/getpaseo/paseo/pull/101))

### Fixed

- Fixed beta 1 bug ([#101](https://github.com/getpaseo/paseo/pull/101))

## 0.16.2 - 2026-11-18

### Fixed

- Fixed 0.16.2 bug ([#99](https://github.com/getpaseo/paseo/pull/99))
`;

test("replaces an earlier beta entry in place for follow-up betas and promotions", () => {
  const tagBeta2 = `# Changelog

## 0.17.0-beta.2 - 2026-11-21

- **Beta 2 highlight:** Updated beta. ([#105](https://github.com/getpaseo/paseo/pull/105))

## 0.16.2 - 2026-11-18

### Fixed

- Fixed 0.16.2 bug ([#99](https://github.com/getpaseo/paseo/pull/99))
`;

  const mergedBeta2 = mergeChangelogEntry(MAIN_CHANGELOG_WITH_BETA, tagBeta2, "0.17.0-beta.2");
  assert.doesNotMatch(mergedBeta2, /## 0\.17\.0-beta\.1/);
  assert.match(mergedBeta2, /^# Changelog\n\n## 0\.17\.0-beta\.2 - 2026-11-21\n/);
  assert.match(mergedBeta2, /## 0\.16\.2 - 2026-11-18/);

  const tagStable = `# Changelog

## 0.17.0 - 2026-11-22

- **Stable highlight:** Shipped stable. ([#105](https://github.com/getpaseo/paseo/pull/105))

## 0.16.2 - 2026-11-18
`;

  const mergedStable = mergeChangelogEntry(mergedBeta2, tagStable, "0.17.0");
  assert.doesNotMatch(mergedStable, /## 0\.17\.0-beta\.2/);
  assert.match(mergedStable, /^# Changelog\n\n## 0\.17\.0 - 2026-11-22\n/);
  assert.match(mergedStable, /## 0\.16\.2 - 2026-11-18/);
});

test("inserts a stable hotfix below a newer active beta entry", () => {
  const tagHotfix = `# Changelog

## 0.16.3 - 2026-11-20

### Fixed

- Fixed urgent 0.16.3 regression ([#103](https://github.com/getpaseo/paseo/pull/103))

## 0.16.2 - 2026-11-18

### Fixed

- Fixed 0.16.2 bug ([#99](https://github.com/getpaseo/paseo/pull/99))
`;

  const merged = mergeChangelogEntry(MAIN_CHANGELOG_WITH_BETA, tagHotfix, "0.16.3");
  const betaIndex = merged.indexOf("## 0.17.0-beta.1 - 2026-11-19");
  const hotfixIndex = merged.indexOf("## 0.16.3 - 2026-11-20");
  const prevStableIndex = merged.indexOf("## 0.16.2 - 2026-11-18");

  assert.ok(betaIndex >= 0 && hotfixIndex > betaIndex && prevStableIndex > hotfixIndex);
});

test("keeps newer beta or promoted stable changelog entries when reconciling an older beta", () => {
  const mainWithBeta2 = `# Changelog

## 0.17.0-beta.2 - 2026-11-21

- **Beta 2 highlight:** Newer beta. ([#105](https://github.com/getpaseo/paseo/pull/105))

## 0.16.2 - 2026-11-18
`;

  const mainWithStable = `# Changelog

## 0.17.0 - 2026-11-22

- **Stable highlight:** Shipped stable. ([#105](https://github.com/getpaseo/paseo/pull/105))

## 0.16.2 - 2026-11-18
`;

  assert.equal(
    mergeChangelogEntry(mainWithBeta2, MAIN_CHANGELOG_WITH_BETA, "0.17.0-beta.1"),
    mainWithBeta2,
  );
  assert.equal(
    mergeChangelogEntry(mainWithStable, MAIN_CHANGELOG_WITH_BETA, "0.17.0-beta.1"),
    mainWithStable,
  );
});

test("reconcileRelease updates changelogs, F-Droid files, and versions only when tag is newer", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "reconcile-release-"));
  try {
    writeFileSync(path.join(dir, "CHANGELOG.md"), MAIN_CHANGELOG_WITH_BETA);
    writeFileSync(
      path.join(dir, "CHANGELOG.zh-CN.md"),
      "# Changelog\n\n## 0.17.0-beta.1 - 2026-11-19\n\n- 旧内容\n\n## 0.16.2 - 2026-11-18\n\n- 0.16.2\n",
    );
    writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "paseo", version: "0.17.0-beta.1" }, null, 2)}\n`,
    );

    const tagFiles = new Map([
      [
        "CHANGELOG.md",
        "# Changelog\n\n## 0.16.3 - 2026-11-20\n\n### Fixed\n\n- Hotfix ([#103](https://github.com/getpaseo/paseo/pull/103))\n\n## 0.16.2 - 2026-11-18\n",
      ],
      [
        "CHANGELOG.zh-CN.md",
        "# Changelog\n\n## 0.16.3 - 2026-11-20\n\n### 修复\n\n- 热修复 ([#103](https://github.com/getpaseo/paseo/pull/103))\n\n## 0.16.2 - 2026-11-18\n",
      ],
      ["fastlane/metadata/android/en-US/changelogs/160031.txt", "Hotfix notes\n"],
      ["fastlane/metadata/android/en-US/changelogs/160032.txt", "Hotfix notes\n"],
    ]);

    const ranCommands = [];
    const hotfixResult = reconcileRelease(
      { tag: "v0.16.3", cwd: dir },
      {
        getFdroidVersionCodes: () => [
          { abi: "armeabi-v7a", versionCode: 160031 },
          { abi: "arm64-v8a", versionCode: 160032 },
        ],
        readTagFile(_tag, filePath) {
          if (!tagFiles.has(filePath)) {
            throw new Error(`Missing ${filePath}`);
          }
          return tagFiles.get(filePath);
        },
        verifyTag: () => {},
        runNpm(args) {
          ranCommands.push(args);
        },
      },
    );

    // Hotfix 0.16.3 is older than main's 0.17.0-beta.1: keep main's version untouched.
    assert.equal(hotfixResult.versionUpdated, false);
    assert.deepEqual(ranCommands, []);
    assert.equal(
      JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).version,
      "0.17.0-beta.1",
    );
    assert.equal(
      readFileSync(path.join(dir, "fastlane/metadata/android/en-US/changelogs/160031.txt"), "utf8"),
      "Hotfix notes\n",
    );
    assert.match(
      readFileSync(path.join(dir, "CHANGELOG.md"), "utf8"),
      /## 0\.17\.0-beta\.1[\s\S]*## 0\.16\.3[\s\S]*## 0\.16\.2/,
    );

    // Now reconcile 0.17.0 promotion (newer than 0.17.0-beta.1): updates root version and runs sync + prepare.
    mkdirSync(path.join(dir, "fastlane/metadata/android/en-US/changelogs"), { recursive: true });
    tagFiles.set(
      "CHANGELOG.md",
      "# Changelog\n\n## 0.17.0 - 2026-11-22\n\n- **Shipped:** Ready. ([#105](https://github.com/getpaseo/paseo/pull/105))\n",
    );
    tagFiles.set(
      "CHANGELOG.zh-CN.md",
      "# Changelog\n\n## 0.17.0 - 2026-11-22\n\n- **已发布**：就绪。([#105](https://github.com/getpaseo/paseo/pull/105))\n",
    );
    tagFiles.set("fastlane/metadata/android/en-US/changelogs/170001.txt", "0.17.0 notes\n");

    const promoResult = reconcileRelease(
      { tag: "v0.17.0", cwd: dir },
      {
        getFdroidVersionCodes: () => [{ abi: "armeabi-v7a", versionCode: 170001 }],
        readTagFile(_tag, filePath) {
          return tagFiles.get(filePath);
        },
        verifyTag: () => {},
        runNpm(args) {
          ranCommands.push(args);
        },
      },
    );

    assert.equal(promoResult.versionUpdated, true);
    assert.equal(
      JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).version,
      "0.17.0",
    );
    assert.deepEqual(ranCommands, [
      ["run", "version:sync-internal"],
      ["run", "release:prepare"],
    ]);
    assert.doesNotMatch(
      readFileSync(path.join(dir, "CHANGELOG.md"), "utf8"),
      /## 0\.17\.0-beta\.1/,
    );
    assert.match(
      readFileSync(path.join(dir, "CHANGELOG.md"), "utf8"),
      /## 0\.17\.0 - 2026-11-22[\s\S]*## 0\.16\.3 - 2026-11-20/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reconcileRelease retries version sync and lockfile install when a prior run failed before updating package-lock.json", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "reconcile-retry-"));
  try {
    writeFileSync(path.join(dir, "CHANGELOG.md"), MAIN_CHANGELOG_WITH_BETA);
    writeFileSync(
      path.join(dir, "CHANGELOG.zh-CN.md"),
      "# Changelog\n\n## 0.17.0-beta.1 - 2026-11-19\n\n- 旧内容\n",
    );
    // Simulate a previous reconcile attempt where package.json was bumped to 0.17.0-beta.2
    // before `npm run release:prepare` failed, leaving package-lock.json at 0.17.0-beta.1.
    writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "paseo", version: "0.17.0-beta.2" }, null, 2)}\n`,
    );
    writeFileSync(
      path.join(dir, "package-lock.json"),
      `${JSON.stringify({ name: "paseo", version: "0.17.0-beta.1", packages: { "": { version: "0.17.0-beta.1" } } }, null, 2)}\n`,
    );

    const tagFiles = new Map([
      ["CHANGELOG.md", "# Changelog\n\n## 0.17.0-beta.2 - 2026-11-21\n\n- Beta 2\n"],
      ["CHANGELOG.zh-CN.md", "# Changelog\n\n## 0.17.0-beta.2 - 2026-11-21\n\n- Beta 2\n"],
    ]);

    const ranCommands = [];
    const result = reconcileRelease(
      { tag: "v0.17.0-beta.2", cwd: dir },
      {
        readTagFile: (_tag, filePath) => tagFiles.get(filePath),
        verifyTag: () => {},
        runNpm(args) {
          ranCommands.push(args);
          if (args[1] === "release:prepare") {
            writeFileSync(
              path.join(dir, "package-lock.json"),
              `${JSON.stringify({ name: "paseo", version: "0.17.0-beta.2", packages: { "": { version: "0.17.0-beta.2" } } }, null, 2)}\n`,
            );
          }
        },
      },
    );

    assert.equal(result.versionUpdated, true);
    assert.deepEqual(ranCommands, [
      ["run", "version:sync-internal"],
      ["run", "release:prepare"],
    ]);

    // A third run once package-lock.json matches is a no-op for version/lockfile sync.
    ranCommands.length = 0;
    const idempotent = reconcileRelease(
      { tag: "v0.17.0-beta.2", cwd: dir },
      {
        readTagFile: (_tag, filePath) => tagFiles.get(filePath),
        verifyTag: () => {},
        runNpm(args) {
          ranCommands.push(args);
        },
      },
    );
    assert.equal(idempotent.versionUpdated, false);
    assert.deepEqual(ranCommands, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
