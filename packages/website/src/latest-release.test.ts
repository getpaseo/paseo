import { describe, expect, it } from "vitest";
import {
  getLatestAndroidVersionFromReleases,
  selectReleaseChannels,
  type GitHubRelease,
} from "./latest-release";

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

function desktopRelease({
  version,
  prerelease = false,
  draft = false,
}: {
  version: string;
  prerelease?: boolean;
  draft?: boolean;
}): GitHubRelease {
  return {
    tag_name: `v${version}`,
    assets: [
      { name: `Paseo-${version}-arm64.dmg` },
      { name: "Paseo-x86_64.AppImage" },
      { name: `Paseo-Setup-${version}-x64.exe` },
      { name: `Paseo-Setup-${version}-arm64.exe` },
    ],
    prerelease,
    draft,
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

describe("selectReleaseChannels", () => {
  it("offers the newest prerelease when it leads stable", () => {
    const channels = selectReleaseChannels([
      desktopRelease({ version: "0.3.0-beta.2", prerelease: true }),
      desktopRelease({ version: "0.3.0-beta.1", prerelease: true }),
      desktopRelease({ version: "0.2.5" }),
    ]);

    expect(channels.stable.version).toBe("0.2.5");
    expect(channels.beta?.version).toBe("0.3.0-beta.2");
    expect(channels.beta?.windowsArm64Asset).toBe("Paseo-Setup-0.3.0-beta.2-arm64.exe");
  });

  it("retires the beta channel once stable ships the same version", () => {
    const channels = selectReleaseChannels([
      desktopRelease({ version: "0.3.0" }),
      desktopRelease({ version: "0.3.0-beta.2", prerelease: true }),
    ]);

    expect(channels.stable.version).toBe("0.3.0");
    expect(channels.beta).toBeNull();
  });

  it("skips drafts and releases whose desktop assets are still uploading", () => {
    const channels = selectReleaseChannels([
      desktopRelease({ version: "0.3.0-beta.3", prerelease: true, draft: true }),
      release({ version: "0.3.0-beta.2", hasApk: true, prerelease: true }),
      desktopRelease({ version: "0.3.0-beta.1", prerelease: true }),
      release({ version: "0.2.5", hasApk: true }),
      desktopRelease({ version: "0.2.4" }),
    ]);

    expect(channels.stable.version).toBe("0.2.4");
    expect(channels.beta?.version).toBe("0.3.0-beta.1");
  });
});
