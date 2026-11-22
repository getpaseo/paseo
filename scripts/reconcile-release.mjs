import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getFdroidVersionCodes as defaultGetFdroidVersionCodes } from "../packages/app/native-release-version.js";
import { parseChangelogEntries } from "./changelog-utils.mjs";
import { isMainModule } from "./is-main-module.mjs";
import {
  compareReleaseVersions,
  normalizeReleaseTag,
  parseReleaseVersion,
} from "./release-version-utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function usageAndExit(code = 1) {
  process.stderr.write("Usage: node scripts/reconcile-release.mjs --tag <vX.Y.Z[-beta.N]>\n");
  process.exit(code);
}

function parseArgs(argv) {
  let tag = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--tag") {
      tag = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usageAndExit(0);
    }
    usageAndExit(1);
  }
  if (!tag) {
    usageAndExit(1);
  }
  return { tag };
}

function splitRawEntries(content) {
  const lines = content.split(/\r?\n/);
  const entries = parseChangelogEntries(content);
  const preamble = lines.slice(0, entries[0].headingLineIndex).join("\n").trimEnd();
  const blocks = entries.map((entry, index) => {
    const nextStart = entries[index + 1]?.headingLineIndex ?? lines.length;
    const raw = lines.slice(entry.headingLineIndex, nextStart).join("\n").trim();
    return { version: entry.version, raw };
  });
  return { preamble, blocks };
}

function safeParseVersion(version) {
  try {
    return parseReleaseVersion(version);
  } catch {
    return null;
  }
}

export function mergeChangelogEntry(mainContent, tagContent, targetVersion) {
  const target = parseReleaseVersion(targetVersion);
  const tagParsed = splitRawEntries(tagContent);
  const taggedBlock = tagParsed.blocks.find((block) => block.version === target.version);
  if (!taggedBlock) {
    throw new Error(`No changelog entry found for ${target.version} in tagged changelog.`);
  }

  const mainParsed = splitRawEntries(mainContent);

  // Never downgrade an already-reconciled newer entry in the same beta series
  // (e.g. a retried beta.1 reconciliation after beta.2 or stable promotion landed).
  if (
    target.isBeta &&
    mainParsed.blocks.some((block) => {
      const existing = safeParseVersion(block.version);
      return (
        existing &&
        existing.baseVersion === target.baseVersion &&
        compareReleaseVersions(existing.version, target.version) > 0
      );
    })
  ) {
    return mainContent;
  }

  const kept = mainParsed.blocks.filter((block) => {
    if (block.version === target.version) {
      return false;
    }
    const existing = safeParseVersion(block.version);
    if (
      existing &&
      existing.isBeta &&
      existing.baseVersion === target.baseVersion &&
      compareReleaseVersions(existing.version, target.version) < 0
    ) {
      return false;
    }
    return true;
  });

  let insertIndex = kept.findIndex((block) => {
    const existing = safeParseVersion(block.version);
    if (!existing) {
      return true;
    }
    return compareReleaseVersions(target.version, existing.version) > 0;
  });

  if (insertIndex === -1) {
    insertIndex = kept.length;
  }

  kept.splice(insertIndex, 0, taggedBlock);

  const parts = [];
  if (mainParsed.preamble.length > 0) {
    parts.push(mainParsed.preamble);
  }
  for (const block of kept) {
    parts.push(block.raw);
  }
  return `${parts.join("\n\n")}\n`;
}

function defaultVerifyTag(tag, cwd) {
  execFileSync("git", ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`], {
    cwd,
    stdio: "ignore",
  });
}

function defaultReadTagFile(tag, filePath, cwd) {
  return execFileSync("git", ["show", `${tag}:${filePath}`], {
    cwd,
    encoding: "utf8",
  });
}

function defaultRunNpm(args, cwd) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

function lockfileMatchesVersion(cwd, rootPackage, version) {
  const lockfilePath = path.join(cwd, "package-lock.json");
  if (!existsSync(lockfilePath)) {
    return true;
  }
  const lockfile = JSON.parse(readFileSync(lockfilePath, "utf8"));
  if (lockfile.version !== version || lockfile.packages?.[""]?.version !== version) {
    return false;
  }
  const workspaces = Array.isArray(rootPackage.workspaces) ? rootPackage.workspaces : [];
  for (const workspace of workspaces) {
    if (lockfile.packages?.[workspace] && lockfile.packages[workspace].version !== version) {
      return false;
    }
  }
  return true;
}

export function reconcileRelease(options, deps = {}) {
  const cwd = options.cwd ?? rootDir;
  const tag = normalizeReleaseTag(options.tag);
  const version = tag.slice(1);
  const parsed = parseReleaseVersion(version);

  const verifyTag = deps.verifyTag ?? ((targetTag) => defaultVerifyTag(targetTag, cwd));
  const readTagFile =
    deps.readTagFile ?? ((targetTag, filePath) => defaultReadTagFile(targetTag, filePath, cwd));
  const runNpm = deps.runNpm ?? ((args) => defaultRunNpm(args, cwd));
  const getFdroidVersionCodes = deps.getFdroidVersionCodes ?? defaultGetFdroidVersionCodes;

  verifyTag(tag);

  for (const changelogFile of ["CHANGELOG.md", "CHANGELOG.zh-CN.md"]) {
    const targetPath = path.join(cwd, changelogFile);
    const mainContent = readFileSync(targetPath, "utf8");
    const tagContent = readTagFile(tag, changelogFile);
    const merged = mergeChangelogEntry(mainContent, tagContent, version);
    writeFileSync(targetPath, merged);
  }

  const fdroidFiles = [];
  if (!parsed.isPrerelease) {
    for (const { versionCode } of getFdroidVersionCodes(version)) {
      const relativePath = path.join(
        "fastlane",
        "metadata",
        "android",
        "en-US",
        "changelogs",
        `${versionCode}.txt`,
      );
      const content = readTagFile(tag, relativePath.replaceAll("\\", "/"));
      const destination = path.join(cwd, relativePath);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, content);
      fdroidFiles.push(relativePath);
    }
  }

  const rootPackagePath = path.join(cwd, "package.json");
  const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8"));
  const currentMainVersion = rootPackage.version;
  const versionComparison = compareReleaseVersions(version, currentMainVersion);

  let versionUpdated = false;
  if (
    versionComparison > 0 ||
    (versionComparison === 0 && !lockfileMatchesVersion(cwd, rootPackage, version))
  ) {
    if (rootPackage.version !== version) {
      rootPackage.version = version;
      writeFileSync(rootPackagePath, `${JSON.stringify(rootPackage, null, 2)}\n`);
    }
    runNpm(["run", "version:sync-internal"]);
    runNpm(["run", "release:prepare"]);
    versionUpdated = true;
    console.log(
      `Updated workspace versions and lockfile from ${currentMainVersion} to ${version}.`,
    );
  } else {
    console.log(`Kept main version at ${currentMainVersion} (newer than or equal to ${version}).`);
  }

  return { tag, version, versionUpdated, fdroidFiles };
}

if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  reconcileRelease(args);
}
