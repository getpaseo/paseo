import { describe, expect, it } from "vitest";
import {
  buildForgeBlobUrl,
  buildForgeBranchTreeUrl,
  buildForgeChecksUrl,
  hasForgeWebUrls,
} from "./forge-url";

describe("buildForgeChecksUrl", () => {
  it("uses each forge's supported change-request checks route", () => {
    expect(buildForgeChecksUrl("github", "https://github.com/acme/repo/pull/12")).toBe(
      "https://github.com/acme/repo/pull/12/checks",
    );
    expect(buildForgeChecksUrl("gitlab", "https://gitlab.com/acme/repo/-/merge_requests/12")).toBe(
      "https://gitlab.com/acme/repo/-/merge_requests/12/pipelines",
    );
  });

  it("returns null when the forge has no separate checks route", () => {
    expect(buildForgeChecksUrl("codeberg", "https://codeberg.org/acme/repo/pulls/12")).toBeNull();
  });

  it("returns null for an unknown forge or invalid change-request URL", () => {
    expect(
      buildForgeChecksUrl("bitbucket", "https://bitbucket.org/acme/repo/pull-requests/12"),
    ).toBeNull();
    expect(buildForgeChecksUrl("gitlab", "not a url")).toBeNull();
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
