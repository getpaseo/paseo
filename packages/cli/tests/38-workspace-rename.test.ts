#!/usr/bin/env npx tsx

import assert from "node:assert";
import { basename } from "node:path";
import { createE2ETestContext } from "./helpers/test-daemon.ts";

console.log("=== Workspace Rename Command ===\n");

const ctx = await createE2ETestContext({ timeout: 30000 });

try {
  const created = await ctx.paseo([
    "workspace",
    "create",
    "--isolation",
    "local",
    "--path",
    ctx.workDir,
    "--title",
    "Original title",
    "--json",
  ]);
  assert.strictEqual(created.exitCode, 0, created.stderr);
  const workspaceId = JSON.parse(created.stdout).workspaceId as string;

  const renamed = await ctx.paseo(["workspace", "rename", workspaceId, "Auth rework", "--json"]);
  assert.strictEqual(renamed.exitCode, 0, renamed.stderr);
  assert.deepStrictEqual(JSON.parse(renamed.stdout), {
    workspaceId,
    title: "Auth rework",
  });

  const renamedList = await ctx.paseo(["workspace", "ls", "--json"]);
  assert.strictEqual(renamedList.exitCode, 0, renamedList.stderr);
  assert.strictEqual(
    JSON.parse(renamedList.stdout).find(
      (workspace: { workspaceId: string }) => workspace.workspaceId === workspaceId,
    )?.name,
    "Auth rework",
  );

  const reset = await ctx.paseo(["workspace", "rename", workspaceId, "--reset", "--json"]);
  assert.strictEqual(reset.exitCode, 0, reset.stderr);
  assert.deepStrictEqual(JSON.parse(reset.stdout), { workspaceId, title: null });

  const resetList = await ctx.paseo(["workspace", "ls", "--json"]);
  assert.strictEqual(resetList.exitCode, 0, resetList.stderr);
  assert.strictEqual(
    JSON.parse(resetList.stdout).find(
      (workspace: { workspaceId: string }) => workspace.workspaceId === workspaceId,
    )?.name,
    basename(ctx.workDir),
  );
} finally {
  await ctx.stop();
}

console.log("=== Workspace Rename Command Tests Passed ===");
