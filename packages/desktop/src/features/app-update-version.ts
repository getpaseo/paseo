interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[];
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const NUMERIC_IDENTIFIER = /^\d+$/;

function parseVersion(version: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(version.trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = NUMERIC_IDENTIFIER.test(left);
  const rightNumeric = NUMERIC_IDENTIFIER.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function comparePrerelease(left: string[], right: string[]): number {
  // A release sorts after its own prereleases.
  if (left.length === 0 || right.length === 0) return right.length - left.length;

  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const order = comparePrereleaseIdentifier(left[index], right[index]);
    if (order !== 0) return order;
  }
  return left.length - right.length;
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (let index = 0; index < left.core.length; index += 1) {
    const order = left.core[index] - right.core[index];
    if (order !== 0) return order;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/** False when either side is not a version, so an unknown version never counts as an update. */
export function isNewerVersion(candidate: string, baseline: string): boolean {
  const parsedCandidate = parseVersion(candidate);
  const parsedBaseline = parseVersion(baseline);
  if (!parsedCandidate || !parsedBaseline) return false;
  return compareVersions(parsedCandidate, parsedBaseline) > 0;
}

/** True only for the release that directly follows `previous` on the same minor line. */
export function isNextPatchRelease(previous: string, next: string): boolean {
  const parsedPrevious = parseVersion(previous);
  const parsedNext = parseVersion(next);
  if (!parsedPrevious || !parsedNext) return false;
  if (parsedPrevious.prerelease.length > 0 || parsedNext.prerelease.length > 0) return false;

  const [previousMajor, previousMinor, previousPatch] = parsedPrevious.core;
  const [nextMajor, nextMinor, nextPatch] = parsedNext.core;
  return (
    nextMajor === previousMajor && nextMinor === previousMinor && nextPatch === previousPatch + 1
  );
}
