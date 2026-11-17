import type { ChangelogRelease } from "./parse-changelog";

/**
 * A minor version as the reader sees it: the entry that opened it and every
 * patch after it.
 *
 * `CHANGELOG.md` keeps one entry per version, because the release scripts read
 * each version's heading and installed apps keep the parser they shipped with.
 * Grouping is how the sheet shows those entries, so the highlights stay those
 * of the minor: a patch sits behind Show all changes with the rest of the
 * record and never replaces or pushes them down.
 */
export interface ChangelogReleaseGroup {
  /** `0.16` for `0.16.1`. A version that has no minor is a group of its own. */
  version: string;
  /** The minor, or the beta's version while the minor has shipped only as a beta. */
  label: string;
  /** The highlights of the entry that opened the minor. */
  highlights: string;
  /**
   * Newest first, as authored. The entry that opened the minor comes last and
   * no longer carries the highlights, which the group shows above them.
   */
  releases: ChangelogRelease[];
}

const MINOR_VERSION = /^(\d+\.\d+)(?:\.|$)/;

/** Joins consecutive entries of the same minor, in document order. */
export function groupReleases(releases: readonly ChangelogRelease[]): ChangelogReleaseGroup[] {
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
      label: isPrerelease(opening.version) ? opening.version : version,
      highlights: opening.highlights,
      releases: [...entries.slice(0, -1), { ...opening, highlights: "" }],
    };
  });
}

function minorVersion(version: string): string {
  return version.match(MINOR_VERSION)?.[1] ?? version;
}

function isPrerelease(version: string): boolean {
  return version.includes("-");
}

export interface RevealedGroups {
  groups: ChangelogReleaseGroup[];
  hasMore: boolean;
}

/**
 * The groups that fit in `count` items. A group with highlights is one item,
 * because its entries render only when the reader opens them. A group without
 * highlights shows its entries, so each one is an item and the group is cut at
 * the one that reaches the count: the oldest minor holds over a hundred.
 */
export function revealGroups(
  groups: readonly ChangelogReleaseGroup[],
  count: number,
): RevealedGroups {
  const shown: ChangelogReleaseGroup[] = [];
  let remaining = count;
  for (const group of groups) {
    if (remaining <= 0) return { groups: shown, hasMore: true };
    if (group.highlights) {
      shown.push(group);
      remaining -= 1;
      continue;
    }
    const releases = group.releases.slice(0, remaining);
    shown.push(releases.length === group.releases.length ? group : { ...group, releases });
    remaining -= group.releases.length;
  }
  return { groups: shown, hasMore: remaining < 0 };
}
