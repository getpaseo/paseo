import englishChangelog from "../../../CHANGELOG.md?raw";
import chineseChangelog from "../../../CHANGELOG.zh-CN.md?raw";
import { DEFAULT_LOCALE, type Locale, localizePath } from "~/i18n";

export interface ChangelogRelease {
  version: string;
  date: string;
  /** Markdown before the first `###` section; empty when the release opens with a section. */
  highlights: string;
  /** Markdown from the first `###` section to the end of the release; the full record. */
  sections: string;
  /** The language of the notes; English when the release has no translation yet. */
  locale: Locale;
}

/**
 * A minor version as the page shows it: the entry that opened it and every patch after it.
 *
 * `CHANGELOG.md` keeps one entry per version, because the release scripts read each version's
 * heading and installed apps keep the parser they shipped with. Grouping is how the page shows
 * those entries, so the highlights stay those of the minor: a patch adds one closed row under
 * them and never replaces or pushes them down.
 */
export interface ChangelogReleaseGroup {
  /** `0.16` for `0.16.1`; the group's anchor. */
  version: string;
  /** The highlights of the entry that opened the minor. */
  highlights: string;
  /** The language of the highlights. */
  locale: Locale;
  /**
   * Newest first, as authored. The entry that opened the minor comes last and no longer carries
   * the highlights, which the group shows above them.
   */
  releases: ChangelogRelease[];
}

// The app's What's new sheet and the release scripts parse the same file with their own code.
// `scripts/test-support/changelog-structure.json` holds the cases all three must split the same
// way; a change to the structure rules starts there.
const releaseHeadingPattern = /^## (.+?) - (\d{4}-\d{2}-\d{2})$/;
const sectionHeadingPattern = /^ {0,3}###(?:[ \t]|$)/;
const fencePattern = /^\s*(`{3,}|~{3,})/;

export function releaseAnchor(version: string): string {
  return `release-${version}`;
}

function minorVersion(version: string): string {
  return version.split(".").slice(0, 2).join(".");
}

interface ReleaseDraft {
  version: string;
  date: string;
  highlights: string[];
  sections: string[];
}

export function parseChangelog(markdown: string, locale: Locale): ChangelogRelease[] {
  const releases: ReleaseDraft[] = [];
  const versions = new Set<string>();
  let currentRelease: ReleaseDraft | null = null;
  // A `##` or `###` inside a fenced code block is an example, so it starts nothing.
  let fence: string | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    const fenceEdge = line.match(fencePattern)?.[1];
    if (fenceEdge) {
      if (!fence) {
        fence = fenceEdge;
      } else if (fenceEdge[0] === fence[0] && fenceEdge.length >= fence.length) {
        fence = null;
      }
    }

    const heading = fence ? null : line.match(releaseHeadingPattern);
    if (heading) {
      const version = heading[1];
      if (versions.has(version)) {
        throw new Error(`Duplicate changelog version: ${version}`);
      }
      versions.add(version);

      if (currentRelease) releases.push(currentRelease);
      currentRelease = { version, date: heading[2], highlights: [], sections: [] };
      continue;
    }

    if (!currentRelease) continue;
    const startsSection = !fence && sectionHeadingPattern.test(line);
    if (currentRelease.sections.length > 0 || startsSection) {
      currentRelease.sections.push(line);
    } else {
      currentRelease.highlights.push(line);
    }
  }

  if (currentRelease) releases.push(currentRelease);
  return releases.map((release) => ({
    version: release.version,
    date: release.date,
    highlights: joinWithoutBlankEdges(release.highlights),
    sections: joinWithoutBlankEdges(release.sections),
    locale,
  }));
}

function joinWithoutBlankEdges(lines: string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start += 1;
  while (end > start && lines[end - 1].trim() === "") end -= 1;
  return lines.slice(start, end).join("\n");
}

/**
 * The English releases, each replaced by its translation when one exists. A translation counts
 * only when it carries the same version and date as the English entry, so a stale translation never
 * stands in for newer notes. A release without a current translation is shown whole in English, and
 * a translation whose English entry was renamed or removed, such as a promoted beta, is dropped:
 * a release never waits on its translation.
 */
export function localizeReleases(
  english: readonly ChangelogRelease[],
  translated: readonly ChangelogRelease[],
): ChangelogRelease[] {
  const byVersion = new Map(translated.map((release) => [release.version, release]));
  return english.map((release) => {
    const translation = byVersion.get(release.version);
    return translation?.date === release.date ? translation : release;
  });
}

export function groupChangelogReleases(releases: ChangelogRelease[]): ChangelogReleaseGroup[] {
  const runs: { version: string; releases: ChangelogRelease[] }[] = [];

  for (const release of releases) {
    const version = minorVersion(release.version);
    const run = runs.at(-1);
    if (run?.version === version) {
      run.releases.push(release);
    } else {
      runs.push({ version, releases: [release] });
    }
  }

  return runs.map(({ version, releases: entries }) => {
    const opening = entries[entries.length - 1];
    return {
      version,
      highlights: opening.highlights,
      locale: opening.locale,
      releases: [...entries.slice(0, -1), { ...opening, highlights: "" }],
    };
  });
}

const englishReleases = parseChangelog(englishChangelog, DEFAULT_LOCALE);

const releaseGroups: Record<Locale, ChangelogReleaseGroup[]> = {
  en: groupChangelogReleases(englishReleases),
  "zh-CN": groupChangelogReleases(
    localizeReleases(englishReleases, parseChangelog(chineseChangelog, "zh-CN")),
  ),
};

export function getChangelogReleaseGroups(locale: Locale): ChangelogReleaseGroup[] {
  return releaseGroups[locale];
}

/**
 * Deep link from a downloadable version to its notes.
 *
 * Links the minor group rather than the exact entry: a `-beta.N` entry is
 * rewritten in place on promotion, so its anchor disappears while the group
 * anchor survives — and the group is the stable-to-beta diff a beta downloader
 * came to read. Versions the bundled changelog doesn't know about (a tag whose
 * changelog commit hasn't been deployed yet) get the plain changelog, never a
 * dead anchor.
 */
export function changelogLink(version: string, locale: Locale): { to: string; hash?: string } {
  const to = localizePath("/changelog", locale);
  const known = englishReleases.some((release) => release.version === version);
  return known ? { to, hash: releaseAnchor(minorVersion(version)) } : { to };
}
