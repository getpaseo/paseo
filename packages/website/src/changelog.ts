import englishChangelog from "../../../CHANGELOG.md?raw";
import chineseChangelog from "../../../CHANGELOG.zh-CN.md?raw";
import { DEFAULT_LOCALE, type Locale, localizePath } from "~/i18n";

export interface ChangelogRelease {
  version: string;
  date: string;
  markdown: string;
  /** The language of `markdown`; English when the release has no translation yet. */
  locale: Locale;
}

export interface ChangelogReleaseGroup {
  version: string;
  releases: ChangelogRelease[];
}

const releaseHeadingPattern = /^## (.+?) - (\d{4}-\d{2}-\d{2})$/;

export function releaseAnchor(version: string): string {
  return `release-${version}`;
}

function minorVersion(version: string): string {
  return version.split(".").slice(0, 2).join(".");
}

export function parseChangelog(markdown: string, locale: Locale): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  const versions = new Set<string>();
  let currentRelease: ChangelogRelease | null = null;

  for (const line of markdown.split("\n")) {
    const heading = line.match(releaseHeadingPattern);
    if (heading) {
      const version = heading[1];
      if (versions.has(version)) {
        throw new Error(`Duplicate changelog version: ${version}`);
      }
      versions.add(version);

      if (currentRelease) releases.push(currentRelease);
      currentRelease = {
        version,
        date: heading[2],
        markdown: "",
        locale,
      };
      continue;
    }

    if (currentRelease) currentRelease.markdown += `${line}\n`;
  }

  if (currentRelease) releases.push(currentRelease);
  return releases;
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

function groupChangelogReleases(releases: ChangelogRelease[]): ChangelogReleaseGroup[] {
  const groups: ChangelogReleaseGroup[] = [];

  for (const release of releases) {
    const version = minorVersion(release.version);
    const currentGroup = groups.at(-1);
    if (currentGroup?.version === version) {
      currentGroup.releases.push(release);
    } else {
      groups.push({ version, releases: [release] });
    }
  }

  return groups;
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
