import { hostname } from "node:os";
import type { Command } from "commander";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { describe, expect, test } from "vitest";
import { runArchiveCommandWithDeps } from "./archive.js";
import { runCreateCommandWithDeps } from "./create.js";
import { runLsCommandWithDeps } from "./ls.js";

function createRemoteDaemonClient(): DaemonClient {
  return {
    isLocalDaemonConnection: () => false,
    getLastServerInfoMessage: () => ({ hostname: hostname() }),
    fetchAgents: async () => ({ entries: [] }),
    getPaseoWorktreeList: async () => ({ worktrees: [], error: null, requestId: "req-list" }),
    createPaseoWorktree: async () => ({ workspace: null, error: null, requestId: "req-create" }),
    archivePaseoWorktree: async () => ({
      success: true,
      removedAgents: [],
      error: null,
      requestId: "req-archive",
    }),
    close: async () => {},
  } as unknown as DaemonClient;
}

const remoteDaemon = createRemoteDaemonClient();
const deps = { connectToDaemon: async () => remoteDaemon };
const command = {} as Command;

describe("worktree commands with an empty CLI host", () => {
  test("list does not infer the caller cwd after a remote fallback", async () => {
    await expect(runLsCommandWithDeps({ host: "" }, command, deps)).rejects.toMatchObject({
      code: "REPOSITORY_IDENTITY_REQUIRED",
    });
  });

  test("create does not infer the caller cwd after a remote fallback", async () => {
    await expect(
      runCreateCommandWithDeps(
        { host: "", mode: "branch-off", newBranch: "feature" },
        command,
        deps,
      ),
    ).rejects.toMatchObject({ code: "REPOSITORY_IDENTITY_REQUIRED" });
  });

  test("archive does not infer the caller cwd after a remote fallback", async () => {
    await expect(runArchiveCommandWithDeps("feature", { host: "" }, deps)).rejects.toMatchObject({
      code: "REPOSITORY_IDENTITY_REQUIRED",
    });
  });
});
