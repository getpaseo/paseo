import { describe, expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { runArchiveCommandWithDeps } from "./archive.js";

function createFakeDaemonClient(
  overrides: Partial<
    Pick<DaemonClient, "getPaseoWorktreeList" | "archivePaseoWorktree" | "close">
  > = {},
): DaemonClient {
  return {
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
  it("returns every recursively archived agent when archiving by worktree path", async () => {
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
          removedAgents: ["agent-root", "agent-middle", "agent-grandchild"],
          error: null,
          requestId: "req-archive",
        };
      },
    });

    const result = await runArchiveCommandWithDeps(
      "feature",
      { host: "localhost:6767" },
      {
        connectToDaemon: async () => fakeClient,
      },
    );

    expect(archiveCalls).toHaveLength(1);
    expect(archiveCalls[0]?.input.scope).toBe("worktree");
    expect(archiveCalls[0]?.input.worktreePath).toBe(worktreePath);
    expect(result).toEqual({
      type: "single",
      data: {
        name: "feature",
        status: "archived",
        removedAgents: ["agent-root", "agent-middle", "agent-grandchild"],
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
      { host: "localhost:6767" },
      {
        connectToDaemon: async () => fakeClient,
      },
    );

    expect(archiveCalls).toHaveLength(1);
    expect(archiveCalls[0]?.input.scope).toBe("worktree");
    expect(archiveCalls[0]?.input.worktreePath).toBe(worktreePath);
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
        { host: "localhost:6767" },
        {
          connectToDaemon: async () => fakeClient,
        },
      ),
    ).rejects.toMatchObject({
      code: "WORKTREE_NOT_FOUND",
    });
  });

  it("keeps exact unique partial receipts on a failed archive", async () => {
    const worktreePath = "/tmp/paseo-home/worktrees/repo/partial-failure";
    const fakeClient = createFakeDaemonClient({
      getPaseoWorktreeList: async () => ({
        worktrees: [
          {
            worktreePath,
            branchName: "partial-failure",
            head: "abc123",
            createdAt: "2026-08-02T00:00:00.000Z",
          },
        ],
        error: null,
        requestId: "req-list",
      }),
      archivePaseoWorktree: async () => ({
        success: false,
        removedAgents: ["agent-first", "agent-second", "agent-first"],
        error: { code: "UNKNOWN", message: "Workspace record teardown failed" },
        requestId: "req-archive",
      }),
    });

    await expect(
      runArchiveCommandWithDeps(
        "partial-failure",
        { host: "localhost:6767" },
        { connectToDaemon: async () => fakeClient },
      ),
    ).rejects.toMatchObject({
      code: "WORKTREE_ARCHIVE_FAILED",
      message: "Failed to archive worktree: Workspace record teardown failed",
      removedAgents: ["agent-first", "agent-second"],
      details: "Archived agents before failure: agent-first, agent-second",
    });
  });
});
