import { describe, expect, test, vi } from "vitest";
import { basename, resolve } from "node:path";

import {
  classifyDirectoryForProjectMembership,
  deriveProjectGroupingName,
  deriveProjectRootPath,
  deriveWorkspaceKind,
  deriveWorkspaceId,
  detectStaleWorkspaces,
} from "./workspace-registry-model.js";
import { createPersistedWorkspaceRecord } from "./workspace-registry.js";

function createWorkspaceRecord(cwd: string, workspaceId: string) {
  return createPersistedWorkspaceRecord({
    workspaceId,
    projectId: workspaceId,
    cwd,
    kind: "directory",
    displayName: basename(cwd) || cwd,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
  });
}

describe("deriveProjectGroupingName", () => {
  test("returns owner/repo for a github remote project key", () => {
    expect(deriveProjectGroupingName("remote:github.com/acme/app")).toBe("acme/app");
  });

  test("returns owner/repo for a gitlab remote project key", () => {
    expect(deriveProjectGroupingName("remote:gitlab.com/acme/app")).toBe("acme/app");
  });

  test("returns last two segments for a self-hosted remote project key", () => {
    expect(deriveProjectGroupingName("remote:git.acme.internal/platform/api")).toBe("platform/api");
  });

  test("returns last two segments for a deeply-nested remote project key", () => {
    expect(deriveProjectGroupingName("remote:gitlab.com/group/sub/app")).toBe("sub/app");
  });

  test("returns the lone path segment when only one segment follows the host", () => {
    expect(deriveProjectGroupingName("remote:github.com/solo")).toBe("solo");
  });

  test("returns the trailing path segment for a non-remote project key", () => {
    expect(deriveProjectGroupingName("/repo/local")).toBe("local");
  });

  test("returns the project key itself when no segments are present", () => {
    expect(deriveProjectGroupingName("")).toBe("");
  });
});

describe("detectStaleWorkspaces", () => {
  test("returns workspace ids whose directories no longer exist", async () => {
    const checkDirectoryExists = vi.fn(async (cwd: string) => cwd !== "/tmp/missing");

    const staleWorkspaceIds = await detectStaleWorkspaces({
      activeWorkspaces: [
        createWorkspaceRecord("/tmp/existing", "ws-existing"),
        createWorkspaceRecord("/tmp/missing", "ws-missing"),
      ],
      checkDirectoryExists,
    });

    expect(Array.from(staleWorkspaceIds)).toEqual(["ws-missing"]);
    expect(checkDirectoryExists.mock.calls).toEqual([["/tmp/existing"], ["/tmp/missing"]]);
  });

  test("keeps workspaces whose directories exist even when all agents are archived", async () => {
    const staleWorkspaceIds = await detectStaleWorkspaces({
      activeWorkspaces: [
        createWorkspaceRecord("/tmp/repo", "ws-repo"),
        createWorkspaceRecord("/tmp/other", "ws-other"),
      ],
      checkDirectoryExists: async () => true,
    });

    expect(Array.from(staleWorkspaceIds)).toEqual([]);
  });

  test("keeps workspaces with no agents when directory exists", async () => {
    const staleWorkspaceIds = await detectStaleWorkspaces({
      activeWorkspaces: [
        createWorkspaceRecord("/tmp/active", "ws-active"),
        createWorkspaceRecord("/tmp/no-agents", "ws-no-agents"),
      ],
      checkDirectoryExists: async () => true,
    });

    expect(Array.from(staleWorkspaceIds)).toEqual([]);
  });
});

describe("deriveWorkspaceId", () => {
  test("uses git worktree root when available", () => {
    expect(
      deriveWorkspaceId("/tmp/repo/packages/app", {
        cwd: "/tmp/repo/packages/app",
        isGit: true,
        currentBranch: "main",
        remoteUrl: "https://github.com/acme/repo.git",
        worktreeRoot: "/tmp/repo",
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      }),
    ).toBe("/tmp/repo");
  });

  test("falls back to normalized cwd when git worktree root contains multiple lines", () => {
    const cwd = String.raw`E:\project\node-ai`;

    expect(
      deriveWorkspaceId(cwd, {
        cwd,
        isGit: true,
        currentBranch: "main",
        remoteUrl: null,
        worktreeRoot: `--path-format=absolute\n${cwd}`,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      }),
    ).toBe(resolve(cwd));
  });

  test("falls back to normalized cwd for non-git directories", () => {
    const cwd = "/tmp/repo/../repo/scratch";

    expect(
      deriveWorkspaceId(cwd, {
        cwd,
        isGit: false,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      }),
    ).toBe(resolve("/tmp/repo/scratch"));
  });
});

describe("git worktree grouping", () => {
  test("classifies plain git worktrees for project membership from git facts", () => {
    const membership = classifyDirectoryForProjectMembership({
      cwd: "/tmp/repo-feature",
      checkout: {
        cwd: "/tmp/repo-feature",
        isGit: true,
        currentBranch: "feature/plain",
        remoteUrl: "https://github.com/acme/repo.git",
        worktreeRoot: "/tmp/repo-feature",
        isPaseoOwnedWorktree: false,
        mainRepoRoot: "/tmp/repo",
      },
    });

    expect(membership).toMatchObject({
      // Slice 1: IDs are still path-shaped; these assertions change in Step B.
      cwd: resolve("/tmp/repo-feature"),
      workspaceId: "/tmp/repo-feature",
      workspaceKind: "worktree",
      workspaceDisplayName: "feature/plain",
      projectKey: "remote:github.com/acme/repo",
      projectName: "acme/repo",
      projectRootPath: "/tmp/repo",
      projectKind: "git",
    });
  });

  test("uses mainRepoRoot as the project root for plain git worktrees", () => {
    expect(
      deriveProjectRootPath({
        cwd: "/tmp/repo-feature",
        checkout: {
          cwd: "/tmp/repo-feature",
          isGit: true,
          currentBranch: "feature/plain",
          remoteUrl: "https://github.com/acme/repo.git",
          worktreeRoot: "/tmp/repo-feature",
          isPaseoOwnedWorktree: false,
          mainRepoRoot: "/tmp/repo",
        },
      }),
    ).toBe("/tmp/repo");
  });

  test("classifies plain git worktrees as workspaces of kind worktree", () => {
    expect(
      deriveWorkspaceKind({
        cwd: "/tmp/repo-feature",
        isGit: true,
        currentBranch: "feature/plain",
        remoteUrl: "https://github.com/acme/repo.git",
        worktreeRoot: "/tmp/repo-feature",
        isPaseoOwnedWorktree: false,
        mainRepoRoot: "/tmp/repo",
      }),
    ).toBe("worktree");
  });
});
