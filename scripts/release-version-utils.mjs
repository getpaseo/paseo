const versionPattern =
  /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-(?<prerelease>[0-9A-Za-z.-]+))?$/;
const sourceTagPattern =
  /^(?:(?:desktop(?:-(?:windows|linux|macos))?|android)-)?v(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

function assertInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

export function parseReleaseVersion(version) {
  const trimmed = version.trim();
  const match = trimmed.match(versionPattern);
  if (!match?.groups) {
    throw new Error(
      `Unsupported release version "${version}". Expected semver like 0.1.41 or 0.1.41-rc.1.`,
    );
  }

  const major = Number.parseInt(match.groups.major, 10);
  const minor = Number.parseInt(match.groups.minor, 10);
  const patch = Number.parseInt(match.groups.patch, 10);
  const prerelease = match.groups.prerelease ?? null;
  const rcMatch = prerelease?.match(/^rc\.(?<rc>\d+)$/) ?? null;
  const rcNumber = rcMatch?.groups?.rc ? Number.parseInt(rcMatch.groups.rc, 10) : null;

  assertInteger(major, "major version");
  assertInteger(minor, "minor version");
  assertInteger(patch, "patch version");
  if (rcNumber !== null) {
    assertInteger(rcNumber, "release candidate number");
  }

  return {
    version: trimmed,
    major,
    minor,
    patch,
    prerelease,
    baseVersion: `${major}.${minor}.${patch}`,
    isPrerelease: prerelease !== null,
    isReleaseCandidate: rcNumber !== null,
    rcNumber,
  };
}

export function formatReleaseVersion({ major, minor, patch, prerelease = null }) {
  assertInteger(major, "major version");
  assertInteger(minor, "minor version");
  assertInteger(patch, "patch version");
  return prerelease ? `${major}.${minor}.${patch}-${prerelease}` : `${major}.${minor}.${patch}`;
}

export function normalizeReleaseTag(rawTag) {
  const trimmed = rawTag.trim().replace(/^refs\/tags\//, "");
  const match = trimmed.match(sourceTagPattern);
  if (!match?.groups?.version) {
    throw new Error(
      `Unsupported release tag "${rawTag}". Expected vX.Y.Z, vX.Y.Z-rc.N, desktop-v..., or android-v...`,
    );
  }
  return `v${match.groups.version}`;
}

export function getReleaseInfoFromSourceTag(sourceTag) {
  const releaseTag = normalizeReleaseTag(sourceTag);
  const parsed = parseReleaseVersion(releaseTag.slice(1));
  return {
    sourceTag,
    releaseTag,
    version: parsed.version,
    baseVersion: parsed.baseVersion,
    prerelease: parsed.prerelease,
    isPrerelease: parsed.isPrerelease,
    isReleaseCandidate: parsed.isReleaseCandidate,
    rcNumber: parsed.rcNumber,
    releaseType: parsed.isPrerelease ? "prerelease" : "release",
    isSmokeTag: sourceTag.includes("gha-smoke"),
  };
}

export function computeNextReleaseVersion(currentVersion, mode) {
  const parsed = parseReleaseVersion(currentVersion);

  if (mode === "patch" || mode === "minor" || mode === "major") {
    if (parsed.isPrerelease) {
      throw new Error(
        `Cannot cut a stable ${mode} release from prerelease version ${currentVersion}. Promote it first.`,
      );
    }
    if (mode === "patch") {
      return formatReleaseVersion({
        major: parsed.major,
        minor: parsed.minor,
        patch: parsed.patch + 1,
      });
    }
    if (mode === "minor") {
      return formatReleaseVersion({
        major: parsed.major,
        minor: parsed.minor + 1,
        patch: 0,
      });
    }
    return formatReleaseVersion({
      major: parsed.major + 1,
      minor: 0,
      patch: 0,
    });
  }

  if (mode === "rc-patch" || mode === "rc-minor" || mode === "rc-major") {
    if (parsed.isPrerelease) {
      throw new Error(
        `Cannot start a new RC line from prerelease version ${currentVersion}. Use rc-next or promote.`,
      );
    }
    if (mode === "rc-patch") {
      return formatReleaseVersion({
        major: parsed.major,
        minor: parsed.minor,
        patch: parsed.patch + 1,
        prerelease: "rc.1",
      });
    }
    if (mode === "rc-minor") {
      return formatReleaseVersion({
        major: parsed.major,
        minor: parsed.minor + 1,
        patch: 0,
        prerelease: "rc.1",
      });
    }
    return formatReleaseVersion({
      major: parsed.major + 1,
      minor: 0,
      patch: 0,
      prerelease: "rc.1",
    });
  }

  if (mode === "rc-next") {
    if (!parsed.isReleaseCandidate || parsed.rcNumber === null) {
      throw new Error(
        `Cannot advance RC number from ${currentVersion}. Expected a version like 0.1.41-rc.1.`,
      );
    }
    return formatReleaseVersion({
      major: parsed.major,
      minor: parsed.minor,
      patch: parsed.patch,
      prerelease: `rc.${parsed.rcNumber + 1}`,
    });
  }

  if (mode === "promote") {
    if (!parsed.isReleaseCandidate) {
      throw new Error(
        `Cannot promote ${currentVersion}. Expected a release candidate version like 0.1.41-rc.1.`,
      );
    }
    return parsed.baseVersion;
  }

  throw new Error(`Unsupported release mode "${mode}".`);
}
