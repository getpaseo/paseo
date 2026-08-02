#!/usr/bin/env npx tsx

import assert from "node:assert";

import { runArchiveCommandWithDeps } from "../dist/commands/worktree/archive.js";
import { renderError } from "../dist/output/render.js";

const worktreePath = "/tmp/paseo-home/worktrees/repo/partial-failure";
const fakeClient = {
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
  close: async () => {},
};

let archiveError: unknown;
try {
  await runArchiveCommandWithDeps(
    "partial-failure",
    { host: "localhost:6767" },
    { connectToDaemon: async () => fakeClient as never },
  );
} catch (error) {
  archiveError = error;
}

assert.ok(archiveError && typeof archiveError === "object");
assert.deepStrictEqual(archiveError, {
  code: "WORKTREE_ARCHIVE_FAILED",
  message: "Failed to archive worktree: Workspace record teardown failed",
  removedAgents: ["agent-first", "agent-second"],
  details: "Archived agents before failure: agent-first, agent-second",
});

const machineOutput = JSON.parse(renderError(archiveError as never, { format: "json" }));
assert.deepStrictEqual(machineOutput.error.removedAgents, ["agent-first", "agent-second"]);

const humanOutput = renderError(archiveError as never, { noColor: true });
assert.match(humanOutput, /Error: Failed to archive worktree: Workspace record teardown failed/);
assert.match(humanOutput, /Archived agents before failure: agent-first, agent-second/);

console.log("Built worktree archive partial receipt test passed");
