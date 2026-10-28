const VERSION_PATTERN = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;

/** Pulls the first semver-looking token out of `--version` output such as "2.1.311 (Claude Code)". */
export function parseCliVersion(output: string): string | null {
  return VERSION_PATTERN.exec(output)?.[0] ?? null;
}

function splitVersion(version: string): { core: number[]; prerelease: string | null } {
  const [core, ...rest] = version.split("-");
  return {
    core: core.split(".").map((part) => Number.parseInt(part, 10) || 0),
    prerelease: rest.length > 0 ? rest.join("-") : null,
  };
}

/** Negative when `a` is older than `b`. A prerelease sorts before its release. */
export function compareCliVersions(a: string, b: string): number {
  const left = splitVersion(a);
  const right = splitVersion(b);
  for (let index = 0; index < Math.max(left.core.length, right.core.length); index += 1) {
    const diff = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (diff !== 0) return diff;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease.localeCompare(right.prerelease);
}

export function isCliUpdateAvailable(installed: string | null, latest: string | null): boolean {
  if (!installed || !latest) return false;
  return compareCliVersions(installed, latest) < 0;
}
