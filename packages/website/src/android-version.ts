import { getNativeBuildVersionCode } from "~android-version-codes";

/**
 * The Android version code for a release, as published at `/android-version.txt`.
 *
 * This is the **base** version code — the one the universal APK on GitHub Releases
 * ships with. It is deliberately not the per-ABI code (`base * 10 + abiSuffix`) that
 * the F-Droid build stamps into its four single-ABI APKs, because the endpoint
 * describes the APK we distribute ourselves. `/android-version.txt` is a public
 * contract with external update checkers, so do not change which of the two it
 * returns without treating that as a breaking change.
 *
 * The formula itself lives in `packages/app/android-version-codes.js` so the app
 * build, the F-Droid metadata, and this endpoint cannot drift apart.
 */
export function getAndroidVersionCode(version: string): number {
  return getNativeBuildVersionCode(version);
}
