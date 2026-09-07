import { describe, expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { runLsCommandWithDeps } from "./ls.js";

function createFakeDaemonClient(
  overrides: Partial<Pick<DaemonClient, "fetchAgents" | "getPaseoWorktreeList" | "close">> = {},
): DaemonClient {
  return {
    fetchAgents: async () => ({
      entries: [],
      requestId: "req-agents",
    }),
    getPaseoWorktreeList: async () => ({
      worktrees: [],
      error: null,
      requestId: "req-list",
    }),
    close: async () => {},
    ...overrides,
  } as unknown as DaemonClient;
}

describe("runLsCommand", () => {
  it("passes process.cwd() to getPaseoWorktreeList when cwd is omitted", async () => {
    const listCalls: Array<Parameters<DaemonClient["getPaseoWorktreeList"]>[0]> = [];
    const fakeClient = createFakeDaemonClient({
      getPaseoWorktreeList: async (input) => {
        listCalls.push(input);
        return {
          worktrees: [],
          error: null,
          requestId: "req-list",
        };
      },
    });

    await runLsCommandWithDeps(
      {},
      {
        connectToDaemon: async () => fakeClient,
      },
    );

    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]).toEqual({ cwd: process.cwd() });
  });

  it("passes explicit cwd to getPaseoWorktreeList when provided", async () => {
    const listCalls: Array<Parameters<DaemonClient["getPaseoWorktreeList"]>[0]> = [];
    const explicitCwd = "/tmp/explicit-repo-root";
    const fakeClient = createFakeDaemonClient({
      getPaseoWorktreeList: async (input) => {
        listCalls.push(input);
        return {
          worktrees: [],
          error: null,
          requestId: "req-list",
        };
      },
    });

    await runLsCommandWithDeps(
      { cwd: explicitCwd },
      {
        connectToDaemon: async () => fakeClient,
      },
    );

    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]).toEqual({ cwd: explicitCwd });
  });
});
