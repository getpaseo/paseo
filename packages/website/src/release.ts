import { createServerFn } from "@tanstack/react-start";
import { getBlockingColdCache } from "./github-cache";

interface GitHubAsset {
  name: string;
}

interface GitHubRelease {
  tag_name: string;
  assets: GitHubAsset[];
  prerelease: boolean;
  draft: boolean;
}

const LINUX_APPIMAGE_ASSET_PATTERN =
  /^Paseo-(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)-)?x86_64\.AppImage$/;

const REQUIRED_ASSET_PATTERNS = [
  /Paseo-.*-arm64\.dmg$/, // Mac Apple Silicon
  LINUX_APPIMAGE_ASSET_PATTERN, // Linux AppImage
  /Paseo-Setup-.*\.exe$/, // Windows (any arch)
];

function hasRequiredAssets(release: GitHubRelease): boolean {
  return REQUIRED_ASSET_PATTERNS.every((pattern) =>
    release.assets.some((asset) => pattern.test(asset.name)),
  );
}

function pickWindowsAssets(assets: GitHubAsset[]) {
  const x64Suffixed = assets.find((a) => /Paseo-Setup-.*-x64\.exe$/.test(a.name));
  const arm64 = assets.find((a) => /Paseo-Setup-.*-arm64\.exe$/.test(a.name));
  const legacy = assets.find(
    (a) =>
      /Paseo-Setup-.*\.exe$/.test(a.name) &&
      !a.name.endsWith("-x64.exe") &&
      !a.name.endsWith("-arm64.exe"),
  );
  return {
    x64: (x64Suffixed ?? legacy)?.name ?? null,
    arm64: arm64?.name ?? null,
  };
}

function pickLinuxAppImageAsset(assets: GitHubAsset[]) {
  return assets.find((a) => LINUX_APPIMAGE_ASSET_PATTERN.test(a.name))?.name ?? null;
}

function versionFromTag(tag: string): string {
  return tag.replace(/^v/, "");
}

interface ReleaseInfo {
  version: string;
  linuxAppImageAsset: string;
  windowsX64Asset: string | null;
  windowsArm64Asset: string | null;
}

const GITHUB_RELEASES_URL = "https://api.github.com/repos/getpaseo/paseo/releases?per_page=10";
const RELEASE_CACHE_KEY = "github-release:v1";

async function fetchLatestReadyRelease(): Promise<ReleaseInfo> {
  const res = await fetch(GITHUB_RELEASES_URL, {
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
  if (!res.ok) throw new Error(`github releases ${res.status}`);

  const releases = (await res.json()) as GitHubRelease[];
  const ready = releases.find((r) => !r.prerelease && !r.draft && hasRequiredAssets(r));
  if (!ready) throw new Error("no ready GitHub release found");
  const win = pickWindowsAssets(ready.assets);
  const linuxAppImageAsset = pickLinuxAppImageAsset(ready.assets);
  if (!linuxAppImageAsset) throw new Error("ready release missing Linux AppImage asset");
  return {
    version: versionFromTag(ready.tag_name),
    linuxAppImageAsset,
    windowsX64Asset: win.x64,
    windowsArm64Asset: win.arm64,
  };
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

export const getLatestRelease = createServerFn({ method: "GET" }).handler(async () => {
  return getBlockingColdCache({
    key: RELEASE_CACHE_KEY,
    isValue: isReleaseInfo,
    fetchFresh: fetchLatestReadyRelease,
  });
});
