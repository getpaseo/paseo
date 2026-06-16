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
      {},
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
      {},
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
        {},
        {
          connectToDaemon: async () => fakeClient,
        },
      ),
    ).rejects.toMatchObject({
      code: "WORKTREE_NOT_FOUND",
    });
  });
});
