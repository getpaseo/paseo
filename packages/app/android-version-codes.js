// Android version codes are derived from the package version instead of a remote
// counter so source-based builders (F-Droid) can compute them from the repo alone.
// See docs/android.md for the formula and its limits.
//
// This module is the single definition of that math. It is consumed by:
//   - app.config.js                      (base versionCode + iOS buildNumber)
//   - plugins/with-fdroid-autolinking.js (per-ABI Gradle override)
//   - scripts/sync-fdroid-changelogs.mjs (F-Droid changelog filenames)
//
// Do not re-derive these numbers anywhere else. A drifted copy silently produces
// F-Droid changelog files that match no published APK, and nothing fails loudly.

// The F-Droid build splits one release into four single-ABI APKs, each of which
// needs its own version code. The suffix order is part of the published contract:
// changing it would make new APKs sort below already-published ones.
const FDROID_ABI_VERSION_CODE_SUFFIXES = {
  "armeabi-v7a": 1,
  "arm64-v8a": 2,
  x86: 3,
  x86_64: 4,
};

const MAX_ANDROID_VERSION_CODE = 2_100_000_000;

function getNativeBuildVersionCode(version) {
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

  if (!Number.isSafeInteger(versionCode) || versionCode <= 0) {
    throw new Error(`Derived Android versionCode is out of range: ${versionCode}`);
  }

  // The F-Droid profile multiplies this by 10 to make room for the ABI suffix, so
  // the base has to stay an order of magnitude below Android's ceiling.
  if (versionCode * 10 + 9 > MAX_ANDROID_VERSION_CODE) {
    throw new Error(
      `Derived Android versionCode leaves no room for the F-Droid ABI suffix: ${versionCode}`,
    );
  }

  return versionCode;
}

function getFdroidAbiVersionCode(baseVersionCode, abi) {
  const suffix = FDROID_ABI_VERSION_CODE_SUFFIXES[abi];
  if (suffix === undefined) {
    throw new Error(`Unsupported Paseo Android ABI: ${abi}`);
  }
  return baseVersionCode * 10 + suffix;
}

// Every version code a single release publishes to F-Droid, in ABI suffix order.
function getFdroidVersionCodes(version) {
  const baseVersionCode = getNativeBuildVersionCode(version);
  return Object.keys(FDROID_ABI_VERSION_CODE_SUFFIXES).map((abi) => ({
    abi,
    versionCode: getFdroidAbiVersionCode(baseVersionCode, abi),
  }));
}

module.exports = {
  FDROID_ABI_VERSION_CODE_SUFFIXES,
  getFdroidAbiVersionCode,
  getFdroidVersionCodes,
  getNativeBuildVersionCode,
};
