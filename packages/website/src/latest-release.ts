import { getBlockingColdCache, type WebsiteCacheContext } from "./github-cache";

interface GitHubAsset {
  name: string;
}

export interface GitHubRelease {
  tag_name: string;
  assets: GitHubAsset[];
  prerelease: boolean;
  draft: boolean;
}

export interface ReleaseInfo {
  version: string;
  linuxAppImageAsset: string;
  windowsX64Asset: string | null;
  windowsArm64Asset: string | null;
}

const LINUX_APPIMAGE_ASSET_PATTERN =
  /^Paseo-(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)-)?x86_64\.AppImage$/;

const REQUIRED_ASSET_PATTERNS = [
  /Paseo-.*-arm64\.dmg$/,
  LINUX_APPIMAGE_ASSET_PATTERN,
  /Paseo-Setup-.*\.exe$/,
];

const GITHUB_RELEASES_URL = "https://api.github.com/repos/getpaseo/paseo/releases?per_page=10";
const RELEASE_CACHE_KEY = "github-release:v1";
const ANDROID_RELEASE_CACHE_KEY = "github-android-release:v1";

function hasRequiredAssets(release: GitHubRelease): boolean {
  return REQUIRED_ASSET_PATTERNS.every((pattern) =>
    release.assets.some((asset) => pattern.test(asset.name)),
  );
}

function pickWindowsAssets(assets: GitHubAsset[]) {
  const x64Suffixed = assets.find((asset) => /Paseo-Setup-.*-x64\.exe$/.test(asset.name));
  const arm64 = assets.find((asset) => /Paseo-Setup-.*-arm64\.exe$/.test(asset.name));
  const legacy = assets.find(
    (asset) =>
      /Paseo-Setup-.*\.exe$/.test(asset.name) &&
      !asset.name.endsWith("-x64.exe") &&
      !asset.name.endsWith("-arm64.exe"),
  );
  return {
    x64: (x64Suffixed ?? legacy)?.name ?? null,
    arm64: arm64?.name ?? null,
  };
}

function pickLinuxAppImageAsset(assets: GitHubAsset[]) {
  return assets.find((asset) => LINUX_APPIMAGE_ASSET_PATTERN.test(asset.name))?.name ?? null;
}

function versionFromTag(tag: string): string {
  return tag.replace(/^v/, "");
}

async function fetchGitHubReleases(): Promise<GitHubRelease[]> {
  const response = await fetch(GITHUB_RELEASES_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "paseo-website",
    },
    cf: {
      cacheEverything: true,
      cacheTtl: 60,
      cacheKey: "github-releases-latest",
    },
  } as RequestInit);
  if (!response.ok) throw new Error(`github releases ${response.status}`);

  return (await response.json()) as GitHubRelease[];
}

async function fetchLatestReadyRelease(): Promise<ReleaseInfo> {
  const releases = await fetchGitHubReleases();
  const ready = releases.find(
    (release) => !release.prerelease && !release.draft && hasRequiredAssets(release),
  );
  if (!ready) throw new Error("no ready GitHub release found");

  const windowsAssets = pickWindowsAssets(ready.assets);
  const linuxAppImageAsset = pickLinuxAppImageAsset(ready.assets);
  if (!linuxAppImageAsset) throw new Error("ready release missing Linux AppImage asset");

  return {
    version: versionFromTag(ready.tag_name),
    linuxAppImageAsset,
    windowsX64Asset: windowsAssets.x64,
    windowsArm64Asset: windowsAssets.arm64,
  };
}

export function getLatestAndroidVersionFromReleases(releases: GitHubRelease[]): string {
  const release = releases.find((candidate) => {
    if (candidate.prerelease || candidate.draft) return false;
    const version = versionFromTag(candidate.tag_name);
    if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
    return candidate.assets.some(
      (asset) => asset.name === `paseo-${candidate.tag_name}-android.apk`,
    );
  });
  if (!release) throw new Error("no stable GitHub release with an Android APK found");
  return versionFromTag(release.tag_name);
}

async function fetchLatestAndroidVersion(): Promise<string> {
  return getLatestAndroidVersionFromReleases(await fetchGitHubReleases());
}

function isAndroidVersion(value: unknown): value is string {
  return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
}

function isReleaseInfo(value: unknown): value is ReleaseInfo {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.version === "string" &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(record.version) &&
    typeof record.linuxAppImageAsset === "string" &&
    (record.linuxAppImageAsset === "Paseo-x86_64.AppImage" ||
      new RegExp(`^Paseo-${record.version.replaceAll(".", "\\.")}-x86_64\\.AppImage$`).test(
        record.linuxAppImageAsset,
      )) &&
    (typeof record.windowsX64Asset === "string" || record.windowsX64Asset === null) &&
    (typeof record.windowsArm64Asset === "string" || record.windowsArm64Asset === null) &&
    (record.windowsX64Asset === null ||
      new RegExp(`^Paseo-Setup-${record.version.replaceAll(".", "\\.")}(?:-x64)?\\.exe$`).test(
        record.windowsX64Asset,
      )) &&
    (record.windowsArm64Asset === null ||
      new RegExp(`^Paseo-Setup-${record.version.replaceAll(".", "\\.")}-arm64\\.exe$`).test(
        record.windowsArm64Asset,
      ))
  );
}

export async function getLatestReleaseInfo(context: WebsiteCacheContext): Promise<ReleaseInfo> {
  return getBlockingColdCache({
    context,
    key: RELEASE_CACHE_KEY,
    isValue: isReleaseInfo,
    fetchFresh: fetchLatestReadyRelease,
  });
}

export async function getLatestAndroidVersion(context: WebsiteCacheContext): Promise<string> {
  return getBlockingColdCache({
    context,
    key: ANDROID_RELEASE_CACHE_KEY,
    isValue: isAndroidVersion,
    fetchFresh: fetchLatestAndroidVersion,
  });
}
