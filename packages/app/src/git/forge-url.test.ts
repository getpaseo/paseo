import { describe, expect, it } from "vitest";
import {
  buildForgeBlobUrl,
  buildForgeBranchTreeUrl,
  buildForgeChecksUrl,
  buildForgeReferenceUrl,
  hasForgeWebUrls,
} from "./forge-url";

describe("buildForgeReferenceUrl", () => {
  it.each([
    ["github", "git@github.com:acme/repo.git", "#", null, "https://github.com/acme/repo/issues/12"],
    ["github", "git@github.com:acme/repo.git", "!", null, null],
    [
      "github",
      "https://github.com/acme/repo",
      "#",
      "other/tools",
      "https://github.com/other/tools/issues/12",
    ],
    ["gitlab", "git@gitlab.com:g/sub/p.git", "#", null, "https://gitlab.com/g/sub/p/-/issues/12"],
    [
      "gitlab",
      "git@gitlab.com:g/sub/p.git",
      "!",
      null,
      "https://gitlab.com/g/sub/p/-/merge_requests/12",
    ],
    [
      "gitlab",
      "https://gitlab.corp:8443/g/p.git",
      "!",
      "g/q",
      "https://gitlab.corp:8443/g/q/-/merge_requests/12",
    ],
    [
      "codeberg",
      "https://codeberg.org/acme/repo.git",
      "!",
      null,
      "https://codeberg.org/acme/repo/pulls/12",
    ],
    [
      "gitea",
      "http://forge.test:3000/team/repo.git",
      "#",
      null,
      "http://forge.test:3000/team/repo/issues/12",
    ],
    [
      "github",
      "http://github.com/acme/repo.git",
      "#",
      null,
      "https://github.com/acme/repo/issues/12",
    ],
    [
      "forgejo",
      "git@forge.example:acme/repo.git",
      "#",
      null,
      "https://forge.example/acme/repo/issues/12",
    ],
    ["bitbucket", "git@bitbucket.org:acme/repo.git", "#", null, null],
    ["github", null, "#", null, null],
    ["github", "git@github.com:acme/repo.git", "#", "../escape", null],
  ] as const)("builds %s %s %s in %s", (forge, remoteUrl, sigil, repo, expected) => {
    expect(buildForgeReferenceUrl(forge, { remoteUrl, repo, sigil, number: 12 })).toBe(expected);
  });

  it("rejects non-positive numbers", () => {
    const remoteUrl = "git@github.com:acme/repo.git";
    expect(buildForgeReferenceUrl("github", { remoteUrl, sigil: "#", number: 0 })).toBeNull();
  });
});

describe("buildForgeChecksUrl", () => {
  it.each([
    [
      "github",
      "https://github.com/acme/repo/pull/12",
      "https://github.com/acme/repo/pull/12/checks",
    ],
    [
      "gitlab",
      "https://gitlab.com/acme/repo/-/merge_requests/12",
      "https://gitlab.com/acme/repo/-/merge_requests/12/pipelines",
    ],
    ["codeberg", "https://codeberg.org/acme/repo/pulls/12", null],
    ["bitbucket", "https://bitbucket.org/acme/repo/pull-requests/12", null],
    ["gitlab", "not a url", null],
  ] as const)("maps the %s checks URL", (forge, url, expected) => {
    expect(buildForgeChecksUrl(forge, url)).toBe(expected);
  });
});

describe("buildForgeBranchTreeUrl", () => {
  it("builds a branch-specific GitHub tree URL", () => {
    expect(
      buildForgeBranchTreeUrl("github", {
        remoteUrl: "git@github.com:acme/repo.git",
        branch: "feature/workspace-button",
      }),
    ).toBe("https://github.com/acme/repo/tree/feature/workspace-button");
  });

  it("encodes reserved branch characters while preserving slash-separated branch names", () => {
    expect(
      buildForgeBranchTreeUrl("github", {
        remoteUrl: "https://github.com/acme/repo.git",
        branch: "feature/ship #42",
      }),
    ).toBe("https://github.com/acme/repo/tree/feature/ship%20%2342");
  });

  it("uses the GitLab /-/tree/ infix and supports subgroups", () => {
    expect(
      buildForgeBranchTreeUrl("gitlab", {
        remoteUrl: "https://gitlab.com/group/sub/repo.git",
        branch: "main",
      }),
    ).toBe("https://gitlab.com/group/sub/repo/-/tree/main");
  });

  it("uses the Gitea-family /src/branch/ infix", () => {
    expect(
      buildForgeBranchTreeUrl("gitea", {
        remoteUrl: "https://gitea.com/acme/repo.git",
        branch: "main",
      }),
    ).toBe("https://gitea.com/acme/repo/src/branch/main");
    expect(
      buildForgeBranchTreeUrl("codeberg", {
        remoteUrl: "https://codeberg.org/acme/repo.git",
        branch: "main",
      }),
    ).toBe("https://codeberg.org/acme/repo/src/branch/main");
  });

  it("preserves a non-default port for a self-hosted https remote", () => {
    expect(
      buildForgeBranchTreeUrl("forgejo", {
        remoteUrl: "https://home-git.example.com:60443/team/repo.git",
        branch: "master",
      }),
    ).toBe("https://home-git.example.com:60443/team/repo/src/branch/master");
  });

  it("omits the port for a self-hosted remote on the default port", () => {
    expect(
      buildForgeBranchTreeUrl("forgejo", {
        remoteUrl: "https://home-git.example.com/team/repo.git",
        branch: "master",
      }),
    ).toBe("https://home-git.example.com/team/repo/src/branch/master");
  });

  it("returns null when the current branch is unavailable", () => {
    expect(
      buildForgeBranchTreeUrl("github", {
        remoteUrl: "https://github.com/acme/repo.git",
        branch: "HEAD",
      }),
    ).toBeNull();
  });

  it("returns null for a forge with no known URL grammar", () => {
    expect(
      buildForgeBranchTreeUrl("bitbucket", {
        remoteUrl: "https://bitbucket.org/acme/repo.git",
        branch: "main",
      }),
    ).toBeNull();
  });
});

describe("buildForgeBlobUrl", () => {
  it("builds a blob URL for a file path", () => {
    expect(
      buildForgeBlobUrl("github", {
        remoteUrl: "git@github.com:acme/repo.git",
        branch: "main",
        path: "src/index.ts",
      }),
    ).toBe("https://github.com/acme/repo/blob/main/src/index.ts");
  });

  it("appends a single-line anchor", () => {
    expect(
      buildForgeBlobUrl("github", {
        remoteUrl: "https://github.com/acme/repo.git",
        branch: "main",
        path: "src/index.ts",
        lineStart: 12,
      }),
    ).toBe("https://github.com/acme/repo/blob/main/src/index.ts#L12");
  });

  it("appends a GitHub line range anchor (#L12-L20)", () => {
    expect(
      buildForgeBlobUrl("github", {
        remoteUrl: "https://github.com/acme/repo.git",
        branch: "main",
        path: "src/index.ts",
        lineStart: 12,
        lineEnd: 20,
      }),
    ).toBe("https://github.com/acme/repo/blob/main/src/index.ts#L12-L20");
  });

  it("uses the GitLab /-/blob/ infix and #L12-20 range anchor", () => {
    expect(
      buildForgeBlobUrl("gitlab", {
        remoteUrl: "https://gitlab.com/group/sub/repo.git",
        branch: "main",
        path: "src/index.ts",
        lineStart: 12,
        lineEnd: 20,
      }),
    ).toBe("https://gitlab.com/group/sub/repo/-/blob/main/src/index.ts#L12-20");
  });

  it("uses the Gitea-family /src/branch/ blob path with a #L12-L20 anchor", () => {
    expect(
      buildForgeBlobUrl("forgejo", {
        remoteUrl: "https://codeberg.org/acme/repo.git",
        branch: "main",
        path: "src/index.ts",
        lineStart: 12,
        lineEnd: 20,
      }),
    ).toBe("https://codeberg.org/acme/repo/src/branch/main/src/index.ts#L12-L20");
  });

  it("derives the web host from a self-hosted remote (GitHub Enterprise)", () => {
    expect(
      buildForgeBlobUrl("github", {
        remoteUrl: "git@github.acme.internal:team/repo.git",
        branch: "main",
        path: "src/index.ts",
      }),
    ).toBe("https://github.acme.internal/team/repo/blob/main/src/index.ts");
  });

  it("preserves a non-default port for a self-hosted https remote", () => {
    expect(
      buildForgeBlobUrl("forgejo", {
        remoteUrl: "https://home-git.example.com:60443/team/repo.git",
        branch: "master",
        path: "src/index.ts",
        lineStart: 12,
        lineEnd: 20,
      }),
    ).toBe("https://home-git.example.com:60443/team/repo/src/branch/master/src/index.ts#L12-L20");
  });

  it("canonicalizes the github.com SSH-alias host to the web host", () => {
    expect(
      buildForgeBlobUrl("github", {
        remoteUrl: "ssh://git@ssh.github.com/acme/repo.git",
        branch: "main",
        path: "src/index.ts",
      }),
    ).toBe("https://github.com/acme/repo/blob/main/src/index.ts");
  });

  it("strips leading slashes and encodes path segments", () => {
    expect(
      buildForgeBlobUrl("github", {
        remoteUrl: "https://github.com/acme/repo.git",
        branch: "main",
        path: "/src/a b/c#d.ts",
      }),
    ).toBe("https://github.com/acme/repo/blob/main/src/a%20b/c%23d.ts");
  });

  it("normalizes harmless dot segments in the blob path", () => {
    expect(
      buildForgeBlobUrl("github", {
        remoteUrl: "https://github.com/acme/repo.git",
        branch: "main",
        path: "./src/../index.ts",
      }),
    ).toBe("https://github.com/acme/repo/blob/main/index.ts");
  });

  it("returns null for blob paths that escape above the repo root", () => {
    expect(
      buildForgeBlobUrl("github", {
        remoteUrl: "https://github.com/acme/repo.git",
        branch: "main",
        path: "../outside.ts",
      }),
    ).toBeNull();
  });

  it("returns null when the path is missing", () => {
    expect(
      buildForgeBlobUrl("github", {
        remoteUrl: "https://github.com/acme/repo.git",
        branch: "main",
        path: "",
      }),
    ).toBeNull();
  });

  it("returns null for a forge with no known URL grammar", () => {
    expect(
      buildForgeBlobUrl("bitbucket", {
        remoteUrl: "https://bitbucket.org/acme/repo.git",
        branch: "main",
        path: "src/index.ts",
      }),
    ).toBeNull();
  });
});

describe("hasForgeWebUrls", () => {
  it("is true for forges with a known URL grammar", () => {
    for (const forge of ["github", "gitlab", "gitea", "forgejo", "codeberg"]) {
      expect(hasForgeWebUrls(forge)).toBe(true);
    }
  });

  it("is false for an unknown forge", () => {
    expect(hasForgeWebUrls("bitbucket")).toBe(false);
  });
});
