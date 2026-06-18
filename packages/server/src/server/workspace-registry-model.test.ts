import { describe, expect, test } from "vitest";
import { basename, isAbsolute, resolve } from "node:path";

import {
  classifyDirectoryForProjectMembership,
  deriveProjectGroupingName,
  deriveProjectRootPath,
  deriveWorkspaceDirectoryKey,
  deriveWorkspaceKind,
  detectStaleWorkspaces,
  generateWorkspaceId,
} from "./workspace-registry-model.js";
import { createPersistedWorkspaceRecord } from "./workspace-registry.js";

function createWorkspaceRecord(
  cwd: string,
  workspaceId: string,
  overrides?: { createdAt?: string; archivedAt?: string },
) {
  return createPersistedWorkspaceRecord({
    workspaceId,
    projectId: workspaceId,
    cwd,
    kind: "directory",
    displayName: basename(cwd) || cwd,
    createdAt: overrides?.createdAt ?? "2026-03-01T00:00:00.000Z",
    updatedAt: overrides?.createdAt ?? "2026-03-01T00:00:00.000Z",
    archivedAt: overrides?.archivedAt ?? null,
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
    const checkedDirectories: string[] = [];
    const existingDirectories = new Set(["/tmp/existing"]);

    const staleWorkspaceIds = await detectStaleWorkspaces({
      activeWorkspaces: [
        createWorkspaceRecord("/tmp/existing", "ws-existing"),
        createWorkspaceRecord("/tmp/missing", "ws-missing"),
      ],
      checkDirectoryExists: async (cwd) => {
        checkedDirectories.push(cwd);
        return existingDirectories.has(cwd);
      },
    });

    expect(Array.from(staleWorkspaceIds)).toEqual(["ws-missing"]);
    expect(checkedDirectories).toEqual(["/tmp/existing", "/tmp/missing"]);
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

describe("deriveWorkspaceDirectoryKey", () => {
  test("uses git worktree root when available", () => {
    expect(
      deriveWorkspaceDirectoryKey("/tmp/repo/packages/app", {
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
      deriveWorkspaceDirectoryKey(cwd, {
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
      deriveWorkspaceDirectoryKey(cwd, {
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

describe("opaque workspace id versus directory key", () => {
  test("generates opaque workspace ids that are not filesystem paths", () => {
    const workspaceId = generateWorkspaceId();

    expect(workspaceId).toMatch(/^wks_[0-9a-f]+$/);
    expect(isAbsolute(workspaceId)).toBe(false);
  });

  test("derives a path-shaped directory key that is never an opaque workspace id", () => {
    const directoryKey = deriveWorkspaceDirectoryKey("/tmp/repo/scratch", {
      cwd: "/tmp/repo/scratch",
      isGit: false,
      currentBranch: null,
      remoteUrl: null,
      worktreeRoot: null,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
    });

    expect(directoryKey).toBe(resolve("/tmp/repo/scratch"));
    expect(directoryKey.startsWith("wks_")).toBe(false);
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
      // Path-derived directory key, distinct from the opaque workspace id (generated separately).
      cwd: resolve("/tmp/repo-feature"),
      workspaceDirectoryKey: "/tmp/repo-feature",
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
