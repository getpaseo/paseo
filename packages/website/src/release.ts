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
  /Paseo-Setup-.*\.exe$/, // Windows
];

function hasRequiredAssets(release: GitHubRelease): boolean {
  return REQUIRED_ASSET_PATTERNS.every((pattern) =>
    release.assets.some((asset) => pattern.test(asset.name)),
  );
}

function versionFromTag(tag: string): string {
  return tag.replace(/^v/, "");
}

const GITHUB_RELEASES_URL = "https://api.github.com/repos/getpaseo/paseo/releases?per_page=10";

async function fetchLatestReadyRelease(): Promise<string> {
  const fallback = websitePackage.version.replace(/-.*$/, "");

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
    return ready ? versionFromTag(ready.tag_name) : fallback;
  } catch {
    return fallback;
  }
}

export const getLatestRelease = createServerFn({ method: "GET" }).handler(async () => {
  const version = await fetchLatestReadyRelease();
  return { version };
});
