#!/usr/bin/env npx tsx

import assert from "node:assert";
import { rm } from "node:fs/promises";
import { createE2ETestContext } from "./helpers/test-daemon.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLoopInList(
  ctx: Awaited<ReturnType<typeof createE2ETestContext>>,
  id: string,
) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const listed = await ctx.paseo(["loop", "ls", "--json"]);
    assert.strictEqual(listed.exitCode, 0, listed.stderr);
    const listedJson = JSON.parse(listed.stdout);
    assert(Array.isArray(listedJson), listed.stdout);
    if (listedJson.some((item: { id: string }) => item.id === id)) {
      return listedJson;
    }
    await sleep(250);
  }

  const listed = await ctx.paseo(["loop", "ls", "--json"]);
  assert.strictEqual(listed.exitCode, 0, listed.stderr);
  return JSON.parse(listed.stdout);
}

console.log("=== Loop And Schedule Command Tests ===\n");

const ctx = await createE2ETestContext({ timeout: 30000 });

try {
  {
    console.log("Test 1: schedule create/ls/inspect/pause/resume/delete work");
    const created = await ctx.paseo(
      [
        "schedule",
        "create",
        "Review new PRs",
        "--every",
        "5m",
        "--name",
        "review-prs",
        "--provider",
        "claude",
        "--json",
      ],
      { timeout: 30000 },
    );
    assert.strictEqual(created.exitCode, 0, created.stderr);
    const createdJson = JSON.parse(created.stdout);
    assert.strictEqual(createdJson.name, "review-prs");
    assert.strictEqual(createdJson.cadence, "every:5m");
    assert(
      typeof createdJson.target === "string" &&
        (createdJson.target.startsWith("agent:") || createdJson.target === "new-agent:claude"),
      created.stdout,
    );

    const listed = await ctx.paseo(["schedule", "ls", "--json"]);
    assert.strictEqual(listed.exitCode, 0, listed.stderr);
    const listedJson = JSON.parse(listed.stdout);
    assert(Array.isArray(listedJson), listed.stdout);
    assert(
      listedJson.some((item: { id: string }) => item.id === createdJson.id),
      listed.stdout,
    );

    const inspected = await ctx.paseo(["schedule", "inspect", createdJson.id, "--json"]);
    assert.strictEqual(inspected.exitCode, 0, inspected.stderr);
    const inspectedJson = JSON.parse(inspected.stdout);
    assert.strictEqual(inspectedJson.status, "active");
    assert.strictEqual(inspectedJson.prompt, "Review new PRs");

    const paused = await ctx.paseo(["schedule", "pause", createdJson.id, "--json"]);
    assert.strictEqual(paused.exitCode, 0, paused.stderr);
    assert.strictEqual(JSON.parse(paused.stdout).status, "paused");

    const resumed = await ctx.paseo(["schedule", "resume", createdJson.id, "--json"]);
    assert.strictEqual(resumed.exitCode, 0, resumed.stderr);
    assert.strictEqual(JSON.parse(resumed.stdout).status, "active");

    const deleted = await ctx.paseo(["schedule", "delete", createdJson.id, "--json"]);
    assert.strictEqual(deleted.exitCode, 0, deleted.stderr);
    assert.strictEqual(JSON.parse(deleted.stdout).id, createdJson.id);
    console.log("schedule commands work\n");
  }

  {
    console.log("Test 1b: schedule create accepts provider/model syntax for new-agent runs");
    const created = await ctx.paseo(
      [
        "schedule",
        "create",
        "Refactor the API layer",
        "--every",
        "10m",
        "--provider",
        "codex/gpt-5.4",
        "--json",
      ],
      { timeout: 30000 },
    );
    assert.strictEqual(created.exitCode, 0, created.stderr);
    const createdJson = JSON.parse(created.stdout);
    assert.strictEqual(createdJson.target, "new-agent:codex/gpt-5.4");

    const inspected = await ctx.paseo(["schedule", "inspect", createdJson.id, "--json"]);
    assert.strictEqual(inspected.exitCode, 0, inspected.stderr);
    const inspectedJson = JSON.parse(inspected.stdout);
    assert.strictEqual(inspectedJson.target.config.provider, "codex");
    assert.strictEqual(inspectedJson.target.config.model, "gpt-5.4");

    const deleted = await ctx.paseo(["schedule", "delete", createdJson.id, "--json"]);
    assert.strictEqual(deleted.exitCode, 0, deleted.stderr);
    console.log("schedule provider/model syntax works\n");
  }

  {
    console.log("Test 1c: schedule create rejects provider with self target");
    const result = await ctx.paseo(
      [
        "schedule",
        "create",
        "Conflicting schedule",
        "--every",
        "5m",
        "--target",
        "self",
        "--provider",
        "codex/gpt-5.4",
      ],
      { timeout: 30000 },
    );
    assert.notStrictEqual(result.exitCode, 0, "should fail for self target with provider");
    const output = result.stdout + result.stderr;
    assert(
      output.includes("can only be used with a new-agent target"),
      "should explain provider target mismatch",
    );
    console.log("schedule rejects provider with self target\n");
  }

  {
    console.log("Test 2: loop run/ls/inspect/logs/stop work");
    const run = await ctx.paseo(
      [
        "loop",
        "run",
        "Return any response",
        "--name",
        "smoke-loop",
        "--verify-check",
        "true",
        "--json",
      ],
      { timeout: 30000 },
    );
    assert.strictEqual(run.exitCode, 0, run.stderr);
    const runJson = JSON.parse(run.stdout);
    assert.strictEqual(runJson.name, "smoke-loop");

    const listedJson = await waitForLoopInList(ctx, runJson.id);
    assert(
      listedJson.some((item: { id: string }) => item.id === runJson.id),
      JSON.stringify(listedJson),
    );

    async function pollStatus(attempt: number): Promise<string> {
      if (attempt >= 40) return "running";
      const inspect = await ctx.paseo(["loop", "inspect", runJson.id, "--json"]);
      assert.strictEqual(inspect.exitCode, 0, inspect.stderr);
      const inspectJson = JSON.parse(inspect.stdout);
      const current = inspectJson.status;
      if (current !== "running") {
        assert.strictEqual(current, "succeeded", inspect.stdout);
        return current;
      }
      await sleep(250);
      return pollStatus(attempt + 1);
    }
    const status = await pollStatus(0);
    assert.strictEqual(status, "succeeded");

    const logs = await ctx.paseo(["loop", "logs", runJson.id], { timeout: 15000 });
    assert.strictEqual(logs.exitCode, 0, logs.stderr);
    assert(logs.stdout.includes("verify-check"), logs.stdout);

    const stopped = await ctx.paseo(["loop", "stop", runJson.id, "--json"]);
    assert.strictEqual(stopped.exitCode, 0, stopped.stderr);
    const stoppedJson = JSON.parse(stopped.stdout);
    assert(["succeeded", "stopped"].includes(stoppedJson.status), stopped.stdout);
    console.log("loop commands work\n");
  }
} finally {
  await ctx.stop();
  await rm(ctx.paseoHome, { recursive: true, force: true });
  await rm(ctx.workDir, { recursive: true, force: true });
}

console.log("=== Loop And Schedule Command Tests Passed ===");
