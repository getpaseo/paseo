import forgeCliVersions from "./forge-cli-versions.json" with { type: "json" };

export type ForgeCliId = "gh" | "glab" | "tea";

export type ForgeCliArchiveKind = "tar.gz" | "none";

export interface ForgeCliAsset {
  url: string;
  archive: ForgeCliArchiveKind;
  /** Path of the binary inside the extracted archive. Unused when archive is "none". */
  binaryPathInArchive?: string;
}

type ForgeCliAssetResolver = (platform: NodeJS.Platform, arch: string) => ForgeCliAsset | null;

interface ForgeCliCatalogEntry {
  version: string;
  resolveAsset: ForgeCliAssetResolver;
}

// linux/darwin arch names in gh/glab/tea release assets use "amd64"/"arm64",
// not node's "x64"/"arm64".
function normalizeArch(arch: string): string | null {
  if (arch === "x64") return "amd64";
  if (arch === "arm64") return "arm64";
  return null;
}

// Pinned versions + sha256 checksums live in forge-cli-versions.json, not
// here, so a version bump is a JSON diff (bumpable by scripts/update-forge-cli-versions.mjs
// and the weekly CI workflow) instead of a TypeScript PR.
const GH_VERSION = forgeCliVersions.gh.version;
const GLAB_VERSION = forgeCliVersions.glab.version;
const TEA_VERSION = forgeCliVersions.tea.version;

// Auto-install only targets the linux container image, see ensureForgeCli.
// Keeping the platform check here too so a direct resolveForgeCliAsset()
// call can't accidentally hand back a darwin/win32 url.
function resolveGhAsset(platform: NodeJS.Platform, arch: string): ForgeCliAsset | null {
  const normalizedArch = normalizeArch(arch);
  if (!normalizedArch || platform !== "linux") return null;

  const dirname = `gh_${GH_VERSION}_linux_${normalizedArch}`;
  return {
    url: `https://github.com/cli/cli/releases/download/v${GH_VERSION}/${dirname}.tar.gz`,
    archive: "tar.gz",
    binaryPathInArchive: `${dirname}/bin/gh`,
  };
}

function resolveGlabAsset(platform: NodeJS.Platform, arch: string): ForgeCliAsset | null {
  const normalizedArch = normalizeArch(arch);
  if (!normalizedArch || platform !== "linux") return null;

  return {
    url: `https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_${normalizedArch}.tar.gz`,
    archive: "tar.gz",
    binaryPathInArchive: "bin/glab",
  };
}

function resolveTeaAsset(platform: NodeJS.Platform, arch: string): ForgeCliAsset | null {
  const normalizedArch = normalizeArch(arch);
  if (!normalizedArch || platform !== "linux") return null;

  return {
    url: `https://dl.gitea.com/tea/${TEA_VERSION}/tea-${TEA_VERSION}-linux-${normalizedArch}`,
    archive: "none",
  };
}

const FORGE_CLI_CATALOG: Record<ForgeCliId, ForgeCliCatalogEntry> = {
  gh: { version: GH_VERSION, resolveAsset: resolveGhAsset },
  glab: { version: GLAB_VERSION, resolveAsset: resolveGlabAsset },
  tea: { version: TEA_VERSION, resolveAsset: resolveTeaAsset },
};

export function getForgeCliVersion(cli: ForgeCliId): string {
  return FORGE_CLI_CATALOG[cli].version;
}

/**
 * Looks up the pinned sha256 for a downloaded asset filename (e.g.
 * "gh_2.96.0_linux_amd64.tar.gz" or "tea-0.3.0-linux-amd64"). Returns null
 * when the filename isn't in forge-cli-versions.json — callers should treat
 * that as "can't verify" rather than a hard failure, see ensure-forge-cli.ts.
 */
export function getForgeCliChecksum(cli: ForgeCliId, assetFilename: string): string | null {
  const checksums: Record<string, string> = forgeCliVersions[cli].checksums;
  return checksums[assetFilename] ?? null;
}

export function resolveForgeCliAsset(
  cli: ForgeCliId,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ForgeCliAsset | null {
  return FORGE_CLI_CATALOG[cli].resolveAsset(platform, arch);
}
