import { describe, expect, it } from "vitest";
import { getForgeCliVersion, resolveForgeCliAsset } from "./forge-cli-catalog.js";

describe("resolveForgeCliAsset", () => {
  it("resolves gh linux amd64", () => {
    expect(resolveForgeCliAsset("gh", "linux", "x64")).toEqual({
      url: "https://github.com/cli/cli/releases/download/v2.96.0/gh_2.96.0_linux_amd64.tar.gz",
      archive: "tar.gz",
      binaryPathInArchive: "gh_2.96.0_linux_amd64/bin/gh",
    });
  });

  it("resolves gh linux arm64", () => {
    expect(resolveForgeCliAsset("gh", "linux", "arm64")).toEqual({
      url: "https://github.com/cli/cli/releases/download/v2.96.0/gh_2.96.0_linux_arm64.tar.gz",
      archive: "tar.gz",
      binaryPathInArchive: "gh_2.96.0_linux_arm64/bin/gh",
    });
  });

  it("resolves glab linux amd64", () => {
    expect(resolveForgeCliAsset("glab", "linux", "x64")).toEqual({
      url: "https://gitlab.com/gitlab-org/cli/-/releases/v1.109.0/downloads/glab_1.109.0_linux_amd64.tar.gz",
      archive: "tar.gz",
      binaryPathInArchive: "bin/glab",
    });
  });

  it("resolves glab linux arm64", () => {
    expect(resolveForgeCliAsset("glab", "linux", "arm64")).toEqual({
      url: "https://gitlab.com/gitlab-org/cli/-/releases/v1.109.0/downloads/glab_1.109.0_linux_arm64.tar.gz",
      archive: "tar.gz",
      binaryPathInArchive: "bin/glab",
    });
  });

  it("resolves tea linux amd64 as a bare binary", () => {
    expect(resolveForgeCliAsset("tea", "linux", "x64")).toEqual({
      url: "https://dl.gitea.com/tea/0.3.0/tea-0.3.0-linux-amd64",
      archive: "none",
    });
  });

  it("resolves tea linux arm64 as a bare binary", () => {
    expect(resolveForgeCliAsset("tea", "linux", "arm64")).toEqual({
      url: "https://dl.gitea.com/tea/0.3.0/tea-0.3.0-linux-arm64",
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
    expect(getForgeCliVersion("gh")).toBe("2.96.0");
    expect(getForgeCliVersion("glab")).toBe("1.109.0");
    expect(getForgeCliVersion("tea")).toBe("0.3.0");
  });
});
