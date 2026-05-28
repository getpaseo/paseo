import { describe, expect, it } from "vitest";
import { buildGitHubBranchTreeUrl, parseGitHubRepoFromRemote } from "./github-url";

describe("parseGitHubRepoFromRemote", () => {
  it.each([
    ["https://github.com/acme/repo.git", "acme/repo"],
    ["https://github.com/acme/repo", "acme/repo"],
    ["http://github.com/acme/repo.git", "acme/repo"],
    ["git@github.com:acme/repo.git", "acme/repo"],
    ["ssh://git@github.com/acme/repo.git", "acme/repo"],
    ["ssh://git@ssh.github.com/acme/repo.git", "acme/repo"],
    ["https://github.com/acme/repo/", "acme/repo"],
  ])("extracts the repo from %s", (remoteUrl, expected) => {
    expect(parseGitHubRepoFromRemote(remoteUrl)).toBe(expected);
  });

  it("returns null for non-GitHub remotes", () => {
    expect(parseGitHubRepoFromRemote("git@gitlab.com:acme/repo.git")).toBeNull();
  });

  it("returns null for invalid URLs", () => {
    expect(parseGitHubRepoFromRemote("not a url")).toBeNull();
  });
});

describe("buildGitHubBranchTreeUrl", () => {
  it("builds a branch-specific GitHub tree URL", () => {
    expect(
      buildGitHubBranchTreeUrl({
        remoteUrl: "git@github.com:acme/repo.git",
        branch: "feature/workspace-button",
      }),
    ).toBe("https://github.com/acme/repo/tree/feature/workspace-button");
  });

  it("encodes reserved branch characters while preserving slash-separated branch names", () => {
    expect(
      buildGitHubBranchTreeUrl({
        remoteUrl: "https://github.com/acme/repo.git",
        branch: "feature/ship #42",
      }),
    ).toBe("https://github.com/acme/repo/tree/feature/ship%20%2342");
  });

  it("returns null when the current branch is unavailable", () => {
    expect(
      buildGitHubBranchTreeUrl({
        remoteUrl: "https://github.com/acme/repo.git",
        branch: "HEAD",
      }),
    ).toBeNull();
  });
});
