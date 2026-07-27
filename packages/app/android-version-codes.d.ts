// Declarations for android-version-codes.js.
//
// The implementation stays untyped CommonJS because app.config.js and the Expo
// config plugin require it with no build step, and EAS/F-Droid evaluate those
// directly. This file lets typed consumers — currently the website, which serves
// the base version code at /android-version.txt — share the formula instead of
// keeping their own copy. See docs/android.md.

/** The ABIs the F-Droid build publishes, in version-code suffix order. */
export type FdroidAbi = "armeabi-v7a" | "arm64-v8a" | "x86" | "x86_64";

export interface FdroidVersionCode {
  abi: FdroidAbi;
  versionCode: number;
}

export declare const FDROID_ABI_VERSION_CODE_SUFFIXES: Record<FdroidAbi, number>;

/**
 * The version code an ordinary (universal) APK ships with: the value in
 * `app.config.js`, and what the iOS `buildNumber` mirrors.
 */
export declare function getNativeBuildVersionCode(version: string): number;

/** Applies a single ABI's suffix: `baseVersionCode * 10 + suffix`. */
export declare function getFdroidAbiVersionCode(baseVersionCode: number, abi: string): number;

/** Every version code one release publishes to F-Droid, in ABI suffix order. */
export declare function getFdroidVersionCodes(version: string): FdroidVersionCode[];
