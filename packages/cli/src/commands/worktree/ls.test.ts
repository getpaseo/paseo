import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { Command } from "commander";
import { describe, expect, test } from "vitest";
import { runLsCommandWithDeps } from "./ls.js";

function createClient(options: { agentCwd: string; worktreePath: string }): DaemonClient {
  return {
    getLastServerInfoMessage: () => ({ hostname: "remote-host" }),
    isLocalDaemonConnection: () => false,
    fetchAgents: async () => ({
      entries: [
        {
          agent: { id: "agent-123456", cwd: options.agentCwd },
          project: { checkout: { worktreeRoot: options.worktreePath } },
        },
      ],
    }),
    getPaseoWorktreeList: async () => ({
      worktrees: [
        {
          worktreePath: options.worktreePath,
          branchName: "feature",
          head: "abc123",
          createdAt: "2026-08-01T00:00:00.000Z",
        },
      ],
      error: null,
      requestId: "req-list",
    }),
    close: async () => {},
  } as unknown as DaemonClient;
}

describe("worktree ls agent association", () => {
  test("uses daemon workspace ownership for a remote agent with a nested cwd", async () => {
    const worktreePath = "/remote/paseo/worktrees/repo/feature";
    const client = createClient({
      agentCwd: `${worktreePath}/packages/server`,
      worktreePath,
    });

    const result = await runLsCommandWithDeps(
      { host: "remote.example", project: "prj_remote" },
      {} as Command,
      { connectToDaemon: async () => client },
    );

    expect(result.data).toEqual([
      {
        name: "feature",
        branch: "feature",
        cwd: worktreePath,
        agent: "agent-1",
      },
    ]);
  });
});
