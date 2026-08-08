import semver from "semver";

/**
 * Whether a daemon version satisfies a plugin manifest's `paseoVersion` range.
 *
 * Prereleases are included deliberately: Paseo ships betas continuously, and
 * plain semver would fail `0.2.7-beta.3` against `>=0.2.6`, marking every
 * plugin unavailable for every beta user.
 *
 * An unparseable daemon version satisfies everything — refusing to run plugins
 * because we cannot read our own version is the worse failure. An unparseable
 * range satisfies nothing, which surfaces as a visible broken row the plugin
 * author can fix.
 */
export function satisfiesVersionRange(daemonVersion: string, range: string): boolean {
  const coerced = semver.valid(daemonVersion) ?? semver.coerce(daemonVersion)?.version ?? null;
  if (coerced === null) {
    return true;
  }
  if (semver.validRange(range) === null) {
    return false;
  }
  return semver.satisfies(coerced, range, { includePrerelease: true });
}
