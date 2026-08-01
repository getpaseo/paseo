import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterAll, describe, expect, test } from "vitest";
import { runArchiveCommandWithDeps } from "./archive.js";
import { runCreateCommandWithDeps } from "./create.js";
import { runLsCommandWithDeps } from "./ls.js";

const tempDir = mkdtempSync(join(tmpdir(), "worktree-cli-nested-root-"));
const repoRoot = join(tempDir, "repo");
const nestedCwd = join(repoRoot, "packages", "cli");
const worktreePath = join(tempDir, "worktrees", "feature");

mkdirSync(nestedCwd, { recursive: true });
execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function createLocalDaemonClient(repoRoots: string[]): DaemonClient {
  return {
    getLastServerInfoMessage: () => ({ hostname: hostname() }),
    isLocalDaemonConnection: () => true,
    listProjects: async () => ({ projects: [], requestId: "req-projects" }),
    fetchAgents: async () => ({ entries: [] }),
    getPaseoWorktreeList: async (input) => {
      if (input.repoRoot) repoRoots.push(input.repoRoot);
      return {
        worktrees: [
          {
            worktreePath,
            branchName: "feature",
            head: "abc123",
            createdAt: "2026-08-01T00:00:00.000Z",
          },
        ],
        error: null,
        requestId: "req-list",
      };
    },
    createPaseoWorktree: async (input) => {
      if (input.repoRoot) repoRoots.push(input.repoRoot);
      return {
        workspace: {
          workspaceDirectory: worktreePath,
          name: "feature",
        },
        error: null,
        requestId: "req-create",
      };
    },
    archivePaseoWorktree: async (input) => {
      if (input.repoRoot) repoRoots.push(input.repoRoot);
      return {
        success: true,
        removedAgents: [],
        error: null,
        requestId: "req-archive",
      };
    },
    close: async () => {},
  } as unknown as DaemonClient;
}

describe("worktree commands from a nested repository directory", () => {
  test("create, list, and archive send the local Git top-level", async () => {
    const repoRoots: string[] = [];
    const client = createLocalDaemonClient(repoRoots);
    const deps = { connectToDaemon: async () => client, cwd: nestedCwd };
    const command = {} as Command;

    await runCreateCommandWithDeps({ mode: "branch-off", newBranch: "feature" }, command, deps);
    await runLsCommandWithDeps({}, command, deps);
    await runArchiveCommandWithDeps("feature", {}, deps);

    expect(repoRoots).toEqual([
      realpathSync.native(repoRoot),
      realpathSync.native(repoRoot),
      realpathSync.native(repoRoot),
      realpathSync.native(repoRoot),
    ]);
  });
});
