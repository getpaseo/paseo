import { execFileSync as nodeExecFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseChangelogEntries } from "./changelog-utils.mjs";
import { getGitHubRelease } from "./github-release.mjs";
import {
  getReleaseInfoFromSourceTag,
  normalizeReleaseTag,
  parseReleaseVersion,
} from "./release-version-utils.mjs";
import { isMainModule } from "./is-main-module.mjs";

function usageAndExit(code = 1) {
  const usage = `
Usage: node scripts/sync-release-notes-from-changelog.mjs [options]

Options:
  --repo <owner/repo>       Repository slug. Defaults to $GITHUB_REPOSITORY.
  --tag <tag>               Release tag (e.g. v0.1.14). Defaults to latest changelog entry.
  --create-if-missing       Create a draft release if it does not already exist.
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
  return parseChangelogEntries(changelogText).map((entry) => {
    const notesParts = [`## ${entry.version} - ${entry.date}`];
    if (entry.bodyLines.length > 0) {
      notesParts.push("", ...entry.bodyLines);
    }

    return Object.assign({}, entry, {
      tag: `v${entry.version}`,
      notes: `${notesParts.join("\n").trim()}\n`,
    });
  });
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

function exposeGitHubContributorMentions(notes) {
  return notes.replace(
    /\[@([A-Za-z0-9-]+)\]\(https:\/\/github\.com\/([A-Za-z0-9-]+)\/?\)/g,
    (match, labelLogin, profileLogin) => {
      if (labelLogin.toLowerCase() !== profileLogin.toLowerCase()) {
        return match;
      }

      return `@${profileLogin}`;
    },
  );
}

export function syncReleaseNotes(argv = process.argv.slice(2), deps = {}) {
  const execFileSync = deps.execFileSync ?? nodeExecFileSync;
  const sleepSync =
    deps.sleepSync ??
    ((milliseconds) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
    });
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

  notes = exposeGitHubContributorMentions(notes);

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
    "--draft",
    ...(parseReleaseVersion(releaseInfo.version).isPrerelease ? ["--prerelease"] : []),
  ];

  try {
    const release = getGitHubRelease(args.repo, targetTag, execFileSync);
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
    } catch (createError) {
      console.warn(
        `Release creation failed for ${targetTag}; attempting edit in case another workflow created it concurrently.`,
      );
      const raceRelease = getGitHubRelease(args.repo, targetTag, execFileSync);
      if (!raceRelease) {
        throw createError;
      }
      updateReleaseNotes({ releaseId: raceRelease.id, repo: args.repo, notesPath }, execFileSync);
      console.log(`Updated release notes for ${targetTag} after create race.`);

      if (createError instanceof Error) {
        console.warn(createError.message);
      }
      return;
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const createdRelease = getGitHubRelease(args.repo, targetTag, execFileSync);
      if (createdRelease) {
        updateReleaseNotes(
          { releaseId: createdRelease.id, repo: args.repo, notesPath },
          execFileSync,
        );
        console.log(`Created release ${targetTag} with changelog notes.`);
        return;
      }
      sleepSync(1_000);
    }
    throw new Error(`Created release ${targetTag} could not be resolved.`);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
}

if (isMainModule(import.meta.url)) {
  syncReleaseNotes();
}
