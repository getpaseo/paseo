import { describe, expect, it } from "vitest";
import {
  getForgeCliChecksum,
  getForgeCliVersion,
  resolveForgeCliAsset,
} from "./forge-cli-catalog.js";
import forgeCliVersions from "./forge-cli-versions.json" with { type: "json" };

// Versions/checksums come from forge-cli-versions.json (bumped by
// scripts/update-forge-cli-versions.mjs), so these tests read the JSON
// instead of hardcoding version strings that a routine bump would break.
const ghVersion = forgeCliVersions.gh.version;
const glabVersion = forgeCliVersions.glab.version;
const teaVersion = forgeCliVersions.tea.version;

describe("resolveForgeCliAsset", () => {
  it("resolves gh linux amd64", () => {
    expect(resolveForgeCliAsset("gh", "linux", "x64")).toEqual({
      url: `https://github.com/cli/cli/releases/download/v${ghVersion}/gh_${ghVersion}_linux_amd64.tar.gz`,
      archive: "tar.gz",
      binaryPathInArchive: `gh_${ghVersion}_linux_amd64/bin/gh`,
    });
  });

  it("resolves gh linux arm64", () => {
    expect(resolveForgeCliAsset("gh", "linux", "arm64")).toEqual({
      url: `https://github.com/cli/cli/releases/download/v${ghVersion}/gh_${ghVersion}_linux_arm64.tar.gz`,
      archive: "tar.gz",
      binaryPathInArchive: `gh_${ghVersion}_linux_arm64/bin/gh`,
    });
  });

  it("resolves glab linux amd64", () => {
    expect(resolveForgeCliAsset("glab", "linux", "x64")).toEqual({
      url: `https://gitlab.com/gitlab-org/cli/-/releases/v${glabVersion}/downloads/glab_${glabVersion}_linux_amd64.tar.gz`,
      archive: "tar.gz",
      binaryPathInArchive: "bin/glab",
    });
  });

  it("resolves glab linux arm64", () => {
    expect(resolveForgeCliAsset("glab", "linux", "arm64")).toEqual({
      url: `https://gitlab.com/gitlab-org/cli/-/releases/v${glabVersion}/downloads/glab_${glabVersion}_linux_arm64.tar.gz`,
      archive: "tar.gz",
      binaryPathInArchive: "bin/glab",
    });
  });

  it("resolves tea linux amd64 as a bare binary", () => {
    expect(resolveForgeCliAsset("tea", "linux", "x64")).toEqual({
      url: `https://dl.gitea.com/tea/${teaVersion}/tea-${teaVersion}-linux-amd64`,
      archive: "none",
    });
  });

  it("resolves tea linux arm64 as a bare binary", () => {
    expect(resolveForgeCliAsset("tea", "linux", "arm64")).toEqual({
      url: `https://dl.gitea.com/tea/${teaVersion}/tea-${teaVersion}-linux-arm64`,
      archive: "none",
    });
  });

  it("returns null for an unsupported arch", () => {
    expect(resolveForgeCliAsset("gh", "linux", "ia32")).toBeNull();
    expect(resolveForgeCliAsset("glab", "linux", "ia32")).toBeNull();
    expect(resolveForgeCliAsset("tea", "linux", "ia32")).toBeNull();
  });

  it("returns null for darwin (not yet supported, zip archives unhandled)", () => {
    expect(resolveForgeCliAsset("gh", "darwin", "arm64")).toBeNull();
  });

  it("returns null for an unsupported platform", () => {
    expect(resolveForgeCliAsset("gh", "win32", "x64")).toBeNull();
    expect(resolveForgeCliAsset("glab", "win32", "x64")).toBeNull();
    expect(resolveForgeCliAsset("tea", "win32", "x64")).toBeNull();
  });

  it("exposes the pinned version per cli", () => {
    expect(getForgeCliVersion("gh")).toBe(ghVersion);
    expect(getForgeCliVersion("glab")).toBe(glabVersion);
    expect(getForgeCliVersion("tea")).toBe(teaVersion);
  });
});

describe("getForgeCliChecksum", () => {
  it("returns the pinned sha256 for a known cli + asset filename", () => {
    const ghFilename = `gh_${ghVersion}_linux_amd64.tar.gz`;
    const teaFilename = `tea-${teaVersion}-linux-arm64`;
    expect(getForgeCliChecksum("gh", ghFilename)).toBe(forgeCliVersions.gh.checksums[ghFilename]);
    expect(getForgeCliChecksum("tea", teaFilename)).toBe(
      forgeCliVersions.tea.checksums[teaFilename],
    );
  });

  it("returns null for an unknown asset filename", () => {
    expect(getForgeCliChecksum("gh", "gh_2.96.0_darwin_amd64.tar.gz")).toBeNull();
    expect(getForgeCliChecksum("gh", "not-a-real-asset")).toBeNull();
  });
});
