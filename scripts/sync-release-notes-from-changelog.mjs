import { execFileSync as nodeExecFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getReleaseInfoFromSourceTag,
  normalizeReleaseTag,
  parseReleaseVersion,
} from "./release-version-utils.mjs";

const headingPattern = /^##\s+\[?([^\]\s]+)\]?\s*-\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\s*$/;

function usageAndExit(code = 1) {
  const usage = `
Usage: node scripts/sync-release-notes-from-changelog.mjs [options]

Options:
  --repo <owner/repo>       Repository slug. Defaults to $GITHUB_REPOSITORY.
  --tag <tag>               Release tag (e.g. v0.1.14). Defaults to latest changelog entry.
  --create-if-missing       Create release if it does not already exist.
`;
  process.stderr.write(usage.trimStart());
  process.stderr.write("\n");
  process.exit(code);
}

function parseArgs(argv) {
  const args = {
    repo: process.env.GITHUB_REPOSITORY || "",
    tag: "",
    createIfMissing: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo") {
      const value = argv[index + 1];
      if (!value) {
        usageAndExit();
      }
      args.repo = value;
      index += 1;
      continue;
    }

    if (arg === "--tag") {
      const value = argv[index + 1];
      if (!value) {
        usageAndExit();
      }
      args.tag = value;
      index += 1;
      continue;
    }

    if (arg === "--create-if-missing") {
      args.createIfMissing = true;
      continue;
    }
    usageAndExit();
  }

  if (!args.repo) {
    throw new Error("Missing repository. Pass --repo or set GITHUB_REPOSITORY.");
  }

  return args;
}

function parseChangelog(changelogText) {
  const lines = changelogText.split(/\r?\n/);
  const headings = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(headingPattern);
    if (!match) {
      continue;
    }

    headings.push({
      version: match[1],
      date: match[2],
      headingLineIndex: index,
    });
  }

  if (headings.length === 0) {
    throw new Error(
      "No release headings found in CHANGELOG.md. Expected headings like `## 0.1.14 - 2026-02-19`.",
    );
  }

  return headings.map((heading, index) => {
    const nextHeading = headings[index + 1];
    const bodyStart = heading.headingLineIndex + 1;
    const bodyEnd = nextHeading ? nextHeading.headingLineIndex : lines.length;

    const bodyLines = lines.slice(bodyStart, bodyEnd);
    while (bodyLines.length > 0 && bodyLines[0].trim() === "") {
      bodyLines.shift();
    }
    while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === "") {
      bodyLines.pop();
    }

    const notesParts = [`## ${heading.version} - ${heading.date}`];
    if (bodyLines.length > 0) {
      notesParts.push("", ...bodyLines);
    }

    return {
      ...heading,
      tag: `v${heading.version}`,
      notes: `${notesParts.join("\n").trim()}\n`,
    };
  });
}

function getRelease(tag, repo, execFileSync = nodeExecFileSync) {
  try {
    const output = execFileSync("gh", ["api", `repos/${repo}/releases/tags/${tag}`], {
      encoding: "utf8",
    });
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function runGh(args, execFileSync = nodeExecFileSync) {
  execFileSync("gh", args, { stdio: "inherit" });
}

function updateReleaseNotes({ releaseId, repo, notesPath }, execFileSync = nodeExecFileSync) {
  runGh(
    ["api", "-X", "PATCH", `repos/${repo}/releases/${releaseId}`, "-F", `body=@${notesPath}`],
    execFileSync,
  );
}

export function syncReleaseNotes(argv = process.argv.slice(2), deps = {}) {
  const execFileSync = deps.execFileSync ?? nodeExecFileSync;
  const args = parseArgs(argv);
  const changelogPath = path.resolve("CHANGELOG.md");
  const changelogText = readFileSync(changelogPath, "utf8");
  const entries = parseChangelog(changelogText);

  const targetTag = args.tag ? normalizeReleaseTag(args.tag) : entries[0].tag;
  const releaseInfo = getReleaseInfoFromSourceTag(targetTag);
  const targetEntry = entries.find((entry) => entry.tag === targetTag);

  let notes = targetEntry?.notes ?? null;

  if (!notes) {
    console.log(`No matching changelog section found for ${targetTag}. Skipping.`);
    return;
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), "paseo-release-notes-"));
  const notesPath = path.join(tempDir, `${targetTag}-notes.md`);
  writeFileSync(notesPath, notes);

  const createArgs = [
    "release",
    "create",
    targetTag,
    "--repo",
    args.repo,
    "--title",
    `Paseo ${targetTag}`,
    "--notes-file",
    notesPath,
    "--verify-tag",
    ...(parseReleaseVersion(releaseInfo.version).isPrerelease ? ["--prerelease"] : []),
  ];

  try {
    const release = getRelease(targetTag, args.repo, execFileSync);
    if (release) {
      updateReleaseNotes({ releaseId: release.id, repo: args.repo, notesPath }, execFileSync);
      console.log(`Updated release notes for ${targetTag}.`);
      return;
    }

    if (!args.createIfMissing) {
      console.log(
        `Release ${targetTag} not found. Skipping because --create-if-missing was not provided.`,
      );
      return;
    }

    try {
      runGh(createArgs, execFileSync);
      console.log(`Created release ${targetTag} with changelog notes.`);
    } catch (createError) {
      console.warn(
        `Release creation failed for ${targetTag}; attempting edit in case another workflow created it concurrently.`,
      );
      const raceRelease = getRelease(targetTag, args.repo, execFileSync);
      if (!raceRelease) {
        throw createError;
      }
      updateReleaseNotes({ releaseId: raceRelease.id, repo: args.repo, notesPath }, execFileSync);
      console.log(`Updated release notes for ${targetTag} after create race.`);

      if (createError instanceof Error) {
        console.warn(createError.message);
      }
    }
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncReleaseNotes();
}
