import changelogMarkdown from "../../../CHANGELOG.md?raw";

export interface ChangelogRelease {
  version: string;
  date: string;
  markdown: string;
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

function parseChangelog(markdown: string): ChangelogRelease[] {
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
      };
      continue;
    }

    if (currentRelease) currentRelease.markdown += `${line}\n`;
  }

  if (currentRelease) releases.push(currentRelease);
  return releases;
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

const changelogReleases = parseChangelog(changelogMarkdown);

export const changelogReleaseGroups = groupChangelogReleases(changelogReleases);

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
export function changelogLink(version: string): { to: "/changelog"; hash?: string } {
  const known = changelogReleases.some((release) => release.version === version);
  return known
    ? { to: "/changelog", hash: releaseAnchor(minorVersion(version)) }
    : { to: "/changelog" };
}
