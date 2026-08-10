import { describe, expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { runArchiveCommandWithDeps } from "./archive.js";
import { createWorktreeCommand } from "./index.js";

const testOptions = { host: "localhost:6767" };

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
  it("registers cwd and repoRoot selectors", () => {
    const archiveCommand = createWorktreeCommand().commands.find(
      (command) => command.name() === "archive",
    );

    expect(archiveCommand?.options.map((option) => option.attributeName())).toEqual(
      expect.arrayContaining(["cwd", "repoRoot"]),
    );
  });

  it("rejects selector-free archive before connecting to the daemon", async () => {
    let connectCalls = 0;

    await expect(
      runArchiveCommandWithDeps("feature", testOptions, {
        connectToDaemon: async () => {
          connectCalls += 1;
          return createFakeDaemonClient();
        },
      }),
    ).rejects.toMatchObject({
      code: "MISSING_WORKTREE_SELECTOR",
      details: expect.stringContaining("--repo-root"),
    });
    expect(connectCalls).toBe(0);
  });

  it("sends scope and expected identity without authorizing the cached path", async () => {
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
      { ...testOptions, cwd: "/repos/repo" },
      {
        connectToDaemon: async () => fakeClient,
      },
    );

    expect(archiveCalls).toHaveLength(1);
    expect(archiveCalls[0]?.input).toEqual({
      repoRoot: "/repos/repo",
      expectedWorktreeIdentity: "feature",
      expectedWorktreePath: worktreePath,
      scope: "worktree",
    });
    expect(archiveCalls[0]?.input).not.toHaveProperty("worktreePath");
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
      { ...testOptions, cwd: "/repos/repo" },
      {
        connectToDaemon: async () => fakeClient,
      },
    );

    expect(archiveCalls).toHaveLength(1);
    expect(archiveCalls[0]?.input).toEqual({
      repoRoot: "/repos/repo",
      expectedWorktreeIdentity: "feature-x",
      expectedWorktreePath: worktreePath,
      scope: "worktree",
    });
  });

  it("refuses to archive either of two same-named worktrees", async () => {
    const firstPath = "/tmp/paseo-home/worktrees/repo-a/shared";
    const secondPath = "/tmp/paseo-home/worktrees/repo-b/shared";
    const archiveCalls: Array<Parameters<DaemonClient["archivePaseoWorktree"]>[0]> = [];
    const fakeClient = createFakeDaemonClient({
      getPaseoWorktreeList: async () => ({
        worktrees: [
          {
            worktreePath: firstPath,
            branchName: "feature-a",
            head: "abc123",
            createdAt: "2026-04-12T00:00:00.000Z",
          },
          {
            worktreePath: secondPath,
            branchName: "feature-b",
            head: "def456",
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

    await expect(
      runArchiveCommandWithDeps(
        "shared",
        { ...testOptions, repoRoot: "/repos/repo" },
        {
          connectToDaemon: async () => fakeClient,
        },
      ),
    ).rejects.toMatchObject({
      code: "WORKTREE_AMBIGUOUS",
      details: expect.stringContaining(`${firstPath} (branch: feature-a)\n${secondPath}`),
    });
    expect(archiveCalls).toEqual([]);
  });

  it.each([
    ["cwd", { cwd: "/repos/repo-a" }],
    ["repoRoot", { repoRoot: "/repos/repo-a" }],
  ] as const)("uses an explicit %s selector to archive one exact target", async (_, selector) => {
    const selectedPath = "/tmp/paseo-home/worktrees/repo-a/shared";
    const listCalls: Array<Parameters<DaemonClient["getPaseoWorktreeList"]>[0]> = [];
    const archiveCalls: Array<Parameters<DaemonClient["archivePaseoWorktree"]>[0]> = [];
    const fakeClient = createFakeDaemonClient({
      getPaseoWorktreeList: async (input) => {
        listCalls.push(input);
        return {
          worktrees: [
            {
              worktreePath: selectedPath,
              branchName: "shared",
              head: "abc123",
              createdAt: "2026-04-12T00:00:00.000Z",
            },
          ],
          error: null,
          requestId: "req-list",
        };
      },
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
      "shared",
      { ...testOptions, ...selector },
      {
        connectToDaemon: async () => fakeClient,
      },
    );

    expect(listCalls).toEqual([{ cwd: undefined, repoRoot: undefined, ...selector }]);
    expect(archiveCalls).toEqual([
      {
        repoRoot: "/repos/repo-a",
        expectedWorktreeIdentity: "shared",
        expectedWorktreePath: selectedPath,
        scope: "worktree",
      },
    ]);
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
        { ...testOptions, cwd: "/repos/repo" },
        {
          connectToDaemon: async () => fakeClient,
        },
      ),
    ).rejects.toMatchObject({
      code: "WORKTREE_NOT_FOUND",
    });
  });
});
