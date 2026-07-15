export function getAndroidVersionCode(version: string): number {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) {
    throw new Error(`Cannot derive Android versionCode from non-semver version: ${version}`);
  }

  const [, majorText, minorText, patchText] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);

  if (minor > 999 || patch > 999) {
    throw new Error(`Cannot derive collision-free Android versionCode from version: ${version}`);
  }

  const versionCode = major * 1_000_000 + minor * 1_000 + patch;
  if (!Number.isSafeInteger(versionCode) || versionCode <= 0 || versionCode > 2_100_000_000) {
    throw new Error(`Derived Android versionCode is out of range: ${versionCode}`);
  }

  return versionCode;
}
