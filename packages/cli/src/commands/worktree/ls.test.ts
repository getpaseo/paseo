import { describe, expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { render } from "../../output/index.js";
import { runLsCommandWithDeps } from "./ls.js";

function createFakeDaemonClient(
  overrides: Partial<Pick<DaemonClient, "fetchAgents" | "getPaseoWorktreeList" | "close">> = {},
): DaemonClient {
  return {
    fetchAgents: async () => ({ entries: [] }),
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
  it("requests worktrees from all registered projects explicitly", async () => {
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

    const result = await runLsCommandWithDeps(
      { host: "localhost:6767" },
      { connectToDaemon: async () => fakeClient },
    );

    expect(listCalls).toEqual([{ allRegisteredProjects: true }]);
    expect(result).toMatchObject({
      type: "single",
      data: {
        inventoryScope: "current_registered_non_archived_git_projects",
        allManagedWorktreesIncluded: false,
        excludedProjectStates: ["archived", "removed"],
        worktrees: [],
      },
    });
    expect(render(result, { noColor: true })).toContain(
      "Scope: current registered, non-archived Git projects only; this is not a complete inventory of all managed worktrees because archived or removed projects are excluded.",
    );
  });

  it("labels the limited inventory scope in structured output", async () => {
    const fakeClient = createFakeDaemonClient({
      getPaseoWorktreeList: async () => ({
        worktrees: [
          {
            worktreePath: "/tmp/paseo-home/worktrees/repo/feature",
            branchName: "feature",
            head: "abc123",
            createdAt: "2026-04-12T00:00:00.000Z",
          },
        ],
        error: null,
        requestId: "req-list",
      }),
    });

    const result = await runLsCommandWithDeps(
      { host: "localhost:6767", format: "json" },
      { connectToDaemon: async () => fakeClient },
    );

    expect(JSON.parse(render(result, { format: "json" }))).toEqual({
      inventoryScope: "current_registered_non_archived_git_projects",
      allManagedWorktreesIncluded: false,
      excludedProjectStates: ["archived", "removed"],
      worktrees: [
        {
          name: "feature",
          branch: "feature",
          cwd: "/tmp/paseo-home/worktrees/repo/feature",
          agent: "-",
        },
      ],
    });
  });

  it("fails instead of returning a known-partial inventory", async () => {
    const fakeClient = createFakeDaemonClient({
      getPaseoWorktreeList: async () => ({
        worktrees: [
          {
            worktreePath: "/tmp/paseo-home/worktrees/repo/feature",
            branchName: "feature",
            head: "abc123",
            createdAt: "2026-04-12T00:00:00.000Z",
          },
        ],
        repositoryErrors: 2,
        error: null,
        requestId: "req-list",
      }),
    });

    await expect(
      runLsCommandWithDeps(
        { host: "localhost:6767", format: "json" },
        { connectToDaemon: async () => fakeClient },
      ),
    ).rejects.toMatchObject({
      code: "WORKTREE_LIST_PARTIAL",
      message: "Failed to list worktrees from 2 registered repositories",
    });
  });
});
