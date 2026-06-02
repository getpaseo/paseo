import { describe, expect, it } from "vitest";
import {
  buildGitHubBlobUrl,
  buildGitHubBranchTreeUrl,
  parseGitHubRepoFromRemote,
} from "./github-url";

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

describe("buildGitHubBlobUrl", () => {
  it("builds a blob URL for a file path", () => {
    expect(
      buildGitHubBlobUrl({
        remoteUrl: "git@github.com:acme/repo.git",
        branch: "main",
        path: "src/index.ts",
      }),
    ).toBe("https://github.com/acme/repo/blob/main/src/index.ts");
  });

  it("appends a single-line anchor", () => {
    expect(
      buildGitHubBlobUrl({
        remoteUrl: "https://github.com/acme/repo.git",
        branch: "main",
        path: "src/index.ts",
        lineStart: 12,
      }),
    ).toBe("https://github.com/acme/repo/blob/main/src/index.ts#L12");
  });

  it("appends a line range anchor", () => {
    expect(
      buildGitHubBlobUrl({
        remoteUrl: "https://github.com/acme/repo.git",
        branch: "main",
        path: "src/index.ts",
        lineStart: 12,
        lineEnd: 20,
      }),
    ).toBe("https://github.com/acme/repo/blob/main/src/index.ts#L12-L20");
  });

  it("strips leading slashes and encodes path segments", () => {
    expect(
      buildGitHubBlobUrl({
        remoteUrl: "https://github.com/acme/repo.git",
        branch: "main",
        path: "/src/a b/c#d.ts",
      }),
    ).toBe("https://github.com/acme/repo/blob/main/src/a%20b/c%23d.ts");
  });

  it("normalizes harmless dot segments in the blob path", () => {
    expect(
      buildGitHubBlobUrl({
        remoteUrl: "https://github.com/acme/repo.git",
        branch: "main",
        path: "./src/../index.ts",
      }),
    ).toBe("https://github.com/acme/repo/blob/main/index.ts");
  });

  it("returns null for blob paths that escape above the repo root", () => {
    expect(
      buildGitHubBlobUrl({
        remoteUrl: "https://github.com/acme/repo.git",
        branch: "main",
        path: "../outside.ts",
      }),
    ).toBeNull();
  });

  it("returns null when the path is missing", () => {
    expect(
      buildGitHubBlobUrl({
        remoteUrl: "https://github.com/acme/repo.git",
        branch: "main",
        path: "",
      }),
    ).toBeNull();
  });
});
