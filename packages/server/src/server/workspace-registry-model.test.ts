import { describe, expect, test, vi } from "vitest";

import { deriveWorkspaceId, detectStaleWorkspaces } from "./workspace-registry-model.js";
import { createPersistedWorkspaceRecord } from "./workspace-registry.js";

function createWorkspaceRecord(workspaceId: string) {
  return createPersistedWorkspaceRecord({
    workspaceId,
    projectId: workspaceId,
    cwd: workspaceId,
    kind: "directory",
    displayName: workspaceId.split("/").at(-1) ?? workspaceId,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
  });
}

describe("detectStaleWorkspaces", () => {
  test("returns workspace ids whose directories no longer exist", async () => {
    const checkDirectoryExists = vi.fn(async (cwd: string) => cwd !== "/tmp/missing");

    const staleWorkspaceIds = await detectStaleWorkspaces({
      activeWorkspaces: [
        createWorkspaceRecord("/tmp/existing"),
        createWorkspaceRecord("/tmp/missing"),
      ],
      checkDirectoryExists,
    });

    expect(Array.from(staleWorkspaceIds)).toEqual(["/tmp/missing"]);
    expect(checkDirectoryExists.mock.calls).toEqual([["/tmp/existing"], ["/tmp/missing"]]);
  });

  test("keeps workspaces whose directories exist even when all agents are archived", async () => {
    const staleWorkspaceIds = await detectStaleWorkspaces({
      activeWorkspaces: [createWorkspaceRecord("/tmp/repo"), createWorkspaceRecord("/tmp/other")],
      checkDirectoryExists: async () => true,
    });

    expect(Array.from(staleWorkspaceIds)).toEqual([]);
  });

  test("keeps workspaces with no agents when directory exists", async () => {
    const staleWorkspaceIds = await detectStaleWorkspaces({
      activeWorkspaces: [
        createWorkspaceRecord("/tmp/active"),
        createWorkspaceRecord("/tmp/no-agents"),
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

  test("falls back to normalized cwd for non-git directories", () => {
    expect(
      deriveWorkspaceId("/tmp/repo/../repo/scratch", {
        cwd: "/tmp/repo/../repo/scratch",
        isGit: false,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      }),
    ).toBe("/tmp/repo/scratch");
  });
});
