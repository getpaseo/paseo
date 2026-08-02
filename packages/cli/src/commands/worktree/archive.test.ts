import { describe, expect, it } from "vitest";
import { hostname } from "node:os";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { runArchiveCommandWithDeps } from "./archive.js";

function createFakeDaemonClient(
  overrides: Partial<
    Pick<
      DaemonClient,
      | "getLastServerInfoMessage"
      | "listProjects"
      | "getPaseoWorktreeList"
      | "archivePaseoWorktree"
      | "close"
      | "isLocalDaemonConnection"
    >
  > = {},
): DaemonClient {
  return {
    getLastServerInfoMessage: () => ({ hostname: hostname() }),
    isLocalDaemonConnection: () => true,
    listProjects: async () => ({ projects: [], requestId: "req-projects" }),
    getPaseoWorktreeList: async () => ({
      worktrees: [],
      error: null,
      requestId: "req-list",
    }),
    archivePaseoWorktree: async () => ({
      success: true,
      removedAgents: [],
      error: null,
      requestId: "req-archive",
    }),
    close: async () => {},
    ...overrides,
  } as unknown as DaemonClient;
}

// NOTE: This file tests CLI routing/resolution only. The actual directory-removal
// outcome is covered by composition: workspace-archive-service.test.ts and
// worktree-session.test.ts prove real filesystem removal end-to-end.

describe("runArchiveCommand", () => {
  it("sends scope worktree when archiving by worktree path", async () => {
    const worktreePath = "/tmp/paseo-home/worktrees/repo/feature";
    const archiveCalls: Array<{
      input: Parameters<DaemonClient["archivePaseoWorktree"]>[0];
    }> = [];
    const fakeClient = createFakeDaemonClient({
      getPaseoWorktreeList: async () => ({
        worktrees: [
          {
            worktreePath,
            branchName: "feature",
            head: "abc123",
            createdAt: "2026-04-12T00:00:00.000Z",
          },
        ],
        error: null,
        requestId: "req-list",
      }),
      archivePaseoWorktree: async (input) => {
        archiveCalls.push({ input });
        return {
          success: true,
          removedAgents: ["agent-1"],
          error: null,
          requestId: "req-archive",
        };
      },
    });

    const result = await runArchiveCommandWithDeps(
      "feature",
      { repoRoot: "/repo" },
      {
        connectToDaemon: async () => fakeClient,
      },
    );

    expect(archiveCalls).toHaveLength(1);
    expect(archiveCalls[0]?.input.scope).toBe("worktree");
    expect(archiveCalls[0]?.input.worktreePath).toBe(worktreePath);
    expect(archiveCalls[0]?.input.repoRoot).toBe("/repo");
    expect(result).toEqual({
      type: "single",
      data: {
        name: "feature",
        status: "archived",
        removedAgents: ["agent-1"],
      },
      schema: expect.any(Object),
    });
  });

  it("archives by matching branch name when no directory name matches", async () => {
    const worktreePath = "/tmp/paseo-home/worktrees/repo/feature-branch";
    const archiveCalls: Array<{
      input: Parameters<DaemonClient["archivePaseoWorktree"]>[0];
    }> = [];
    const fakeClient = createFakeDaemonClient({
      getPaseoWorktreeList: async () => ({
        worktrees: [
          {
            worktreePath,
            branchName: "feature-x",
            head: "abc123",
            createdAt: "2026-04-12T00:00:00.000Z",
          },
        ],
        error: null,
        requestId: "req-list",
      }),
      archivePaseoWorktree: async (input) => {
        archiveCalls.push({ input });
        return {
          success: true,
          removedAgents: [],
          error: null,
          requestId: "req-archive",
        };
      },
    });

    await runArchiveCommandWithDeps(
      "feature-x",
      { repoRoot: "/repo" },
      {
        connectToDaemon: async () => fakeClient,
      },
    );

    expect(archiveCalls).toHaveLength(1);
    expect(archiveCalls[0]?.input.scope).toBe("worktree");
    expect(archiveCalls[0]?.input.worktreePath).toBe(worktreePath);
    expect(archiveCalls[0]?.input.repoRoot).toBe("/repo");
  });

  it("throws a CommandError when the worktree is not found", async () => {
    const fakeClient = createFakeDaemonClient({
      getPaseoWorktreeList: async () => ({
        worktrees: [],
        error: null,
        requestId: "req-list",
      }),
    });

    await expect(
      runArchiveCommandWithDeps(
        "missing",
        {},
        {
          connectToDaemon: async () => fakeClient,
        },
      ),
    ).rejects.toMatchObject({
      code: "WORKTREE_NOT_FOUND",
    });
  });

  it("archives a pending cleanup placement after Git forgets the worktree", async () => {
    const pendingPath = "/tmp/paseo-home/worktrees/repo/pending-cleanup";
    const archiveCalls: Array<Parameters<DaemonClient["archivePaseoWorktree"]>[0]> = [];
    const fakeClient = createFakeDaemonClient({
      getPaseoWorktreeList: async () => ({
        worktrees: [
          {
            worktreePath: pendingPath,
            branchName: "pending-cleanup",
            head: null,
            createdAt: "2026-04-12T00:00:00.000Z",
          },
        ],
        error: null,
        requestId: "req-list",
      }),
      archivePaseoWorktree: async (input) => {
        archiveCalls.push(input);
        return {
          success: true,
          removedAgents: [],
          error: null,
          requestId: "req-archive",
        };
      },
    });

    await runArchiveCommandWithDeps(
      "pending-cleanup",
      { project: "prj-repo" },
      { connectToDaemon: async () => fakeClient },
    );

    expect(archiveCalls).toEqual([
      {
        worktreePath: pendingPath,
        projectId: "prj-repo",
        branchName: "pending-cleanup",
        scope: "worktree",
      },
    ]);
  });

  it("fails closed when a name or branch resolves to multiple worktree paths", async () => {
    const archiveCalls: Array<Parameters<DaemonClient["archivePaseoWorktree"]>[0]> = [];
    const fakeClient = createFakeDaemonClient({
      getPaseoWorktreeList: async () => ({
        worktrees: [
          {
            worktreePath: "/tmp/worktrees/repo/feature",
            branchName: "other-branch",
            head: "abc123",
            createdAt: "2026-04-12T00:00:00.000Z",
          },
          {
            worktreePath: "/tmp/worktrees/repo/pending-cleanup",
            branchName: "feature",
            head: null,
            createdAt: "2026-04-13T00:00:00.000Z",
          },
        ],
        error: null,
        requestId: "req-list",
      }),
      archivePaseoWorktree: async (input) => {
        archiveCalls.push(input);
        return {
          success: true,
          removedAgents: [],
          error: null,
          requestId: "req-archive",
        };
      },
    });

    await expect(
      runArchiveCommandWithDeps(
        "feature",
        { repoRoot: "/repo" },
        { connectToDaemon: async () => fakeClient },
      ),
    ).rejects.toMatchObject({
      code: "AMBIGUOUS_WORKTREE",
      details: "/tmp/worktrees/repo/feature, /tmp/worktrees/repo/pending-cleanup",
    });
    expect(archiveCalls).toEqual([]);
  });
});
