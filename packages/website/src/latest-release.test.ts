import { describe, expect, it } from "vitest";
import { getLatestAndroidVersionFromReleases, type GitHubRelease } from "./latest-release";

function release({
  version,
  hasApk,
  prerelease = false,
}: {
  version: string;
  hasApk: boolean;
  prerelease?: boolean;
}): GitHubRelease {
  const tag = `v${version}`;
  return {
    tag_name: tag,
    assets: hasApk ? [{ name: `paseo-${tag}-android.apk` }] : [],
    prerelease,
    draft: false,
  };
}

describe("getLatestAndroidVersionFromReleases", () => {
  it("selects the latest stable release that contains an Android APK", () => {
    const releases = [
      release({ version: "0.1.109", hasApk: true, prerelease: true }),
      release({ version: "0.1.108", hasApk: false }),
      release({ version: "0.1.107", hasApk: true }),
    ];

    expect(getLatestAndroidVersionFromReleases(releases)).toBe("0.1.107");
  });
});
