import { createServerFn } from "@tanstack/react-start";
import websitePackage from "../package.json";

interface GitHubAsset {
  name: string;
}

interface GitHubRelease {
  tag_name: string;
  assets: GitHubAsset[];
  prerelease: boolean;
  draft: boolean;
}

const REQUIRED_ASSET_PATTERNS = [
  /Paseo-.*-arm64\.dmg$/, // Mac Apple Silicon
  /Paseo-.*-x86_64\.AppImage$/, // Linux AppImage
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

function versionFromTag(tag: string): string {
  return tag.replace(/^v/, "");
}

interface ReleaseInfo {
  version: string;
  windowsX64Asset: string | null;
  windowsArm64Asset: string | null;
}

const GITHUB_RELEASES_URL = "https://api.github.com/repos/getpaseo/paseo/releases?per_page=10";

async function fetchLatestReadyRelease(): Promise<ReleaseInfo> {
  const fallbackVersion = websitePackage.version.replace(/-.*$/, "");
  const fallback: ReleaseInfo = {
    version: fallbackVersion,
    windowsX64Asset: `Paseo-Setup-${fallbackVersion}.exe`,
    windowsArm64Asset: null,
  };

  try {
    const res = await fetch(GITHUB_RELEASES_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "paseo-website",
      },
      // Cloudflare Workers: cache the upstream response with stale-while-revalidate.
      // Fresh for 60s, serve stale for up to 300s while revalidating in background.
      // In non-Workers environments this is ignored.
      cf: {
        cacheEverything: true,
        cacheTtl: 60,
        cacheKey: "github-releases-latest",
      },
    } as RequestInit);
    if (!res.ok) return fallback;

    const releases = (await res.json()) as GitHubRelease[];
    const ready = releases.find((r) => !r.prerelease && !r.draft && hasRequiredAssets(r));
    if (!ready) return fallback;
    const win = pickWindowsAssets(ready.assets);
    return {
      version: versionFromTag(ready.tag_name),
      windowsX64Asset: win.x64,
      windowsArm64Asset: win.arm64,
    };
  } catch {
    return fallback;
  }
}

export const getLatestRelease = createServerFn({ method: "GET" }).handler(async () => {
  return fetchLatestReadyRelease();
});
