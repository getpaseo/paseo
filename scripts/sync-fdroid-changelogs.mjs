// Generates the F-Droid "What's New" files from CHANGELOG.md.
//
// Two things make this non-optional to script:
//
//   1. F-Droid matches `changelogs/<versionCode>.txt` literally, and the F-Droid
//      profile splits one release into four single-ABI APKs with four distinct
//      version codes (see packages/app/native-release-version.js). A single
//      hand-written file matches no published APK, which silently costs the
//      "What's New" entry and the Latest tab placement that depends on it.
//   2. F-Droid caps a changelog at 500 characters. Real Paseo entries run into
//      the thousands, so they have to be compressed rather than copied.
//
// This must run before the release tag is created: fdroidserver only reads
// metadata from the tag it is building, so the file for version N has to exist in
// the commit that N points at. It is wired into the npm `version` lifecycle.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// CommonJS on purpose: packages/app/app.config.js and the Expo config plugin both
// require it, so the ABI table has exactly one definition across all three callers.
import { getFdroidVersionCodes as defaultGetFdroidVersionCodes } from "../packages/app/native-release-version.js";
import { parseChangelogBody, parseChangelogEntries } from "./changelog-utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

// F-Droid's documented cap. fdroidserver truncates past this, so stay under it.
const CHANGELOG_CHARACTER_LIMIT = 500;
const FULL_NOTES_FOOTER = "Full notes: https://paseo.sh/changelog";
const DEFAULT_LOCALE = "en-US";
const METADATA_DIR = path.join("fastlane", "metadata", "android");

function usageAndExit(code = 1) {
  const usage = `
Usage: node scripts/sync-fdroid-changelogs.mjs [options]

Writes fastlane/metadata/android/<locale>/changelogs/<versionCode>.txt for every
ABI the F-Droid build publishes.

Options:
  --version <x.y.z>   Release version. Defaults to the root package.json version.
  --locale <locale>   Metadata locale directory. Defaults to ${DEFAULT_LOCALE}.
  --check             Exit non-zero if the files on disk are missing or stale.
`;
  process.stderr.write(usage.trimStart());
  process.stderr.write("\n");
  process.exit(code);
}

function parseArgs(argv) {
  const args = { check: false, locale: DEFAULT_LOCALE, version: "" };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--version" || arg === "--locale") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        usageAndExit();
      }
      args[arg === "--version" ? "version" : "locale"] = value;
      index += 1;
      continue;
    }
    if (arg === "--check") {
      args.check = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usageAndExit(0);
    }
    usageAndExit();
  }

  return args;
}

function truncateText(text, maxLength) {
  const ellipsis = "...";
  if (maxLength <= ellipsis.length) {
    return "";
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - ellipsis.length).trimEnd()}${ellipsis}`;
}

// Notes claim the budget before any bullet does. Releases use blockquotes for
// action-required notices (0.1.109: "you must reinstall manually"), so bullets are
// what gets cut. A note too long to fit is truncated rather than dropped — losing
// half a warning is recoverable via the footer link, losing all of it is not.
function fitNotes(notes, budget) {
  let noteText = "";

  for (const note of notes) {
    const separator = noteText.length === 0 ? 0 : 2;
    const remaining = budget - noteText.length - separator;
    if (remaining <= 0) {
      break;
    }

    const fitted = truncateText(note, remaining);
    if (fitted.length === 0) {
      break;
    }

    noteText += noteText.length === 0 ? fitted : `\n\n${fitted}`;
  }

  return noteText;
}

// Greedily takes whole section headings and bullets, in order, until the budget runs
// out. Returns the kept lines.
function fitSections(sections, budget) {
  const candidates = [];
  for (const section of sections) {
    if (candidates.length > 0) {
      candidates.push("");
    }
    if (section.title) {
      candidates.push(section.title);
    }
    for (const bullet of section.bullets) {
      candidates.push(`- ${bullet}`);
    }
  }

  const kept = [];
  let length = 0;
  for (const candidate of candidates) {
    const addedLength = kept.length === 0 ? candidate.length : candidate.length + 1;
    if (length + addedLength > budget) {
      break;
    }
    kept.push(candidate);
    length += addedLength;
  }

  // Drop a trailing blank line or a section heading whose bullets all got cut —
  // an orphan heading reads like a bug.
  while (kept.length > 0) {
    const last = kept[kept.length - 1];
    if (last === "" || !last.startsWith("- ")) {
      kept.pop();
      continue;
    }
    break;
  }

  return kept;
}

// Fits blockquoted notices, section headings, and bullets into the character budget,
// always leaving room for the footer that points at the unabridged notes.
export function formatFdroidChangelog(bodyLines, options = {}) {
  const limit = options.limit ?? CHANGELOG_CHARACTER_LIMIT;
  const footer = options.footer ?? FULL_NOTES_FOOTER;
  const { notes, sections } = parseChangelogBody(bodyLines);

  // The rendered file is `body` + "\n\n" + `footer` + "\n", so three newlines and
  // the footer come out of the limit before any content does.
  const budget = limit - footer.length - 3;
  if (budget <= 0) {
    throw new Error(`Changelog limit ${limit} is too small for the footer "${footer}".`);
  }

  const noteText = fitNotes(notes, budget);
  const sectionBudget = budget - noteText.length - (noteText.length > 0 ? 2 : 0);
  const kept = fitSections(sections, sectionBudget);

  if (kept.length === 0 && noteText.length === 0) {
    // Nothing fit whole and there is no notice carrying the entry. Salvage the first
    // bullet so the changelog is never just a bare link.
    const firstBullet = sections[0]?.bullets[0];
    const salvaged = firstBullet ? truncateText(`- ${firstBullet}`, sectionBudget) : "";
    if (salvaged.length > 0) {
      kept.push(salvaged);
    }
  }

  const body = [noteText, kept.join("\n")].filter((part) => part.length > 0).join("\n\n");
  return `${body ? `${body}\n\n` : ""}${footer}\n`;
}

export function syncFdroidChangelogs(argv = process.argv.slice(2), deps = {}) {
  const cwd = deps.cwd ?? rootDir;
  const args = parseArgs(argv);
  const getFdroidVersionCodes = deps.getFdroidVersionCodes ?? defaultGetFdroidVersionCodes;

  const version =
    args.version || JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8")).version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error('Root package.json must contain a valid "version".');
  }

  if (/-beta\.\d+$/.test(version)) {
    console.log(`Skipping F-Droid changelogs for beta ${version}.`);
    return { contents: null, version, versionCodes: [], written: [] };
  }

  const entries = parseChangelogEntries(readFileSync(path.join(cwd, "CHANGELOG.md"), "utf8"));
  const entry = entries.find((candidate) => candidate.version === version);
  if (!entry) {
    throw new Error(
      `No CHANGELOG.md entry found for ${version}. Add the release entry before cutting the release.`,
    );
  }

  const contents = formatFdroidChangelog(entry.bodyLines);
  if (contents.length > CHANGELOG_CHARACTER_LIMIT) {
    throw new Error(
      `Generated F-Droid changelog for ${version} is ${contents.length} characters, over the ${CHANGELOG_CHARACTER_LIMIT} limit.`,
    );
  }

  const changelogDir = path.join(cwd, METADATA_DIR, args.locale, "changelogs");
  const versionCodes = getFdroidVersionCodes(version);
  const stale = [];
  const written = [];

  for (const { abi, versionCode } of versionCodes) {
    const filePath = path.join(changelogDir, `${versionCode}.txt`);
    const relativePath = path.relative(cwd, filePath);
    const current = existsSync(filePath) ? readFileSync(filePath, "utf8") : null;

    if (current === contents) {
      continue;
    }

    if (args.check) {
      stale.push(`${relativePath} (${abi})`);
      continue;
    }

    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents);
    written.push(`${relativePath} (${abi})`);
  }

  if (args.check) {
    if (stale.length > 0) {
      throw new Error(
        `F-Droid changelogs are out of date for ${version}. Run "npm run fdroid:changelogs".\n${stale
          .map((item) => `- ${item}`)
          .join("\n")}`,
      );
    }
    console.log(`F-Droid changelogs are up to date for ${version}.`);
    return { contents, version, versionCodes, written: [] };
  }

  if (written.length === 0) {
    console.log(`F-Droid changelogs already current for ${version}.`);
  } else {
    console.log(`Wrote F-Droid changelogs for ${version} (${contents.length} chars):`);
    for (const item of written) {
      console.log(`- ${item}`);
    }
  }

  return { contents, version, versionCodes, written };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncFdroidChangelogs();
}
