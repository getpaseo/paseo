#!/usr/bin/env npx tsx

import assert from "node:assert";
import { rm } from "node:fs/promises";
import { createE2ETestContext } from "./helpers/test-daemon.ts";

console.log("=== Schedule Command Tests ===\n");

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
    assert.strictEqual(createdJson.cadence, "cron:*/5 * * * *");
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
        "--thinking",
        "high",
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
    assert.strictEqual(inspectedJson.target.config.thinkingOptionId, "high");

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
    console.log("Test 1d: compatibility agent-target schedules remain deletable");
    const created = await ctx.paseo(
      [
        "schedule",
        "create",
        "Legacy heartbeat",
        "--cron",
        "0 0 1 1 *",
        "--target",
        "00000000-0000-4000-8000-000000000001",
        "--json",
      ],
      { timeout: 30000 },
    );
    assert.strictEqual(created.exitCode, 0, created.stderr);
    const createdJson = JSON.parse(created.stdout);
    assert.strictEqual(createdJson.target, "agent:0000000");

    const deleted = await ctx.paseo(["schedule", "delete", createdJson.id, "--json"]);
    assert.strictEqual(deleted.exitCode, 0, deleted.stderr);
    assert.strictEqual(JSON.parse(deleted.stdout).id, createdJson.id);
    console.log("compatibility agent-target schedules remain deletable\n");
  }

  {
    console.log("Test 1e: schedule ls --json includes agent-target schedules");
    const created = await ctx.paseo([
      "schedule",
      "create",
      "List an existing agent schedule",
      "--cron",
      "0 0 1 1 *",
      "--target",
      "00000000-0000-4000-8000-000000000001",
      "--json",
    ]);
    assert.strictEqual(created.exitCode, 0, created.stderr);
    const createdJson = JSON.parse(created.stdout);

    const listed = await ctx.paseo(["schedule", "ls", "--json"]);
    assert.strictEqual(listed.exitCode, 0, listed.stderr);
    const listedJson = JSON.parse(listed.stdout);
    assert(Array.isArray(listedJson), listed.stdout);
    const listedSchedule = listedJson.find((item: { id: string }) => item.id === createdJson.id);
    assert(listedSchedule, listed.stdout);
    assert.deepStrictEqual(Object.keys(listedSchedule).sort(), [
      "cadence",
      "id",
      "lastRunAt",
      "name",
      "nextRunAt",
      "status",
      "target",
    ]);
    assert.strictEqual(listedSchedule.target, "agent:0000000");

    const deleted = await ctx.paseo(["schedule", "delete", createdJson.id, "--json"]);
    assert.strictEqual(deleted.exitCode, 0, deleted.stderr);
    console.log("schedule ls includes agent-target schedules\n");
  }

  {
    console.log("Test 1f: schedule inspect --json returns an agent-target schedule");
    const agentId = "00000000-0000-4000-8000-000000000002";
    const created = await ctx.paseo([
      "schedule",
      "create",
      "Inspect an existing agent schedule",
      "--cron",
      "0 0 1 1 *",
      "--target",
      agentId,
      "--json",
    ]);
    assert.strictEqual(created.exitCode, 0, created.stderr);
    const createdJson = JSON.parse(created.stdout);

    const inspected = await ctx.paseo(["schedule", "inspect", createdJson.id, "--json"]);
    assert.strictEqual(inspected.exitCode, 0, inspected.stderr);
    const inspectedJson = JSON.parse(inspected.stdout);
    assert.deepStrictEqual(inspectedJson.target, { type: "agent", agentId });

    const deleted = await ctx.paseo(["schedule", "delete", createdJson.id, "--json"]);
    assert.strictEqual(deleted.exitCode, 0, deleted.stderr);
    console.log("schedule inspect returns an agent-target schedule\n");
  }

  {
    console.log(
      "Test 1g: schedule logs --json returns an empty run list for an unrun agent-target schedule",
    );
    const created = await ctx.paseo([
      "schedule",
      "create",
      "Read logs for an existing agent schedule",
      "--cron",
      "0 0 1 1 *",
      "--target",
      "00000000-0000-4000-8000-000000000003",
      "--json",
    ]);
    assert.strictEqual(created.exitCode, 0, created.stderr);
    const createdJson = JSON.parse(created.stdout);

    const logs = await ctx.paseo(["schedule", "logs", createdJson.id, "--json"]);
    assert.strictEqual(logs.exitCode, 0, logs.stderr);
    assert.deepStrictEqual(JSON.parse(logs.stdout), []);

    const deleted = await ctx.paseo(["schedule", "delete", createdJson.id, "--json"]);
    assert.strictEqual(deleted.exitCode, 0, deleted.stderr);
    console.log("schedule logs returns an empty agent-target run list\n");
  }

  {
    console.log("Test 1h: schedule pause --json pauses an agent-target schedule");
    const created = await ctx.paseo([
      "schedule",
      "create",
      "Pause an existing agent schedule",
      "--cron",
      "0 0 1 1 *",
      "--target",
      "00000000-0000-4000-8000-000000000004",
      "--json",
    ]);
    assert.strictEqual(created.exitCode, 0, created.stderr);
    const createdJson = JSON.parse(created.stdout);

    const paused = await ctx.paseo(["schedule", "pause", createdJson.id, "--json"]);
    assert.strictEqual(paused.exitCode, 0, paused.stderr);
    const pausedJson = JSON.parse(paused.stdout);
    assert.strictEqual(pausedJson.status, "paused");
    assert.strictEqual(pausedJson.target, "agent:0000000");

    const deleted = await ctx.paseo(["schedule", "delete", createdJson.id, "--json"]);
    assert.strictEqual(deleted.exitCode, 0, deleted.stderr);
    console.log("schedule pause pauses an agent-target schedule\n");
  }

  {
    console.log("Test 1i: schedule resume --json accepts an active agent-target schedule");
    const created = await ctx.paseo([
      "schedule",
      "create",
      "Resume an active existing agent schedule",
      "--cron",
      "0 0 1 1 *",
      "--target",
      "00000000-0000-4000-8000-000000000005",
      "--json",
    ]);
    assert.strictEqual(created.exitCode, 0, created.stderr);
    const createdJson = JSON.parse(created.stdout);

    const resumed = await ctx.paseo(["schedule", "resume", createdJson.id, "--json"]);
    assert.strictEqual(resumed.exitCode, 0, resumed.stderr);
    const resumedJson = JSON.parse(resumed.stdout);
    assert.strictEqual(resumedJson.status, "active");
    assert.strictEqual(resumedJson.target, "agent:0000000");

    const deleted = await ctx.paseo(["schedule", "delete", createdJson.id, "--json"]);
    assert.strictEqual(deleted.exitCode, 0, deleted.stderr);
    console.log("schedule resume accepts an active agent-target schedule\n");
  }

  {
    console.log("Test 1j: schedule run-once --json reaches the agent-target execution path");
    const created = await ctx.paseo([
      "schedule",
      "create",
      "Run a missing existing agent schedule once",
      "--cron",
      "0 0 1 1 *",
      "--target",
      "13131313-1313-4131-8131-131313131313",
      "--json",
    ]);
    assert.strictEqual(created.exitCode, 0, created.stderr);
    const createdJson = JSON.parse(created.stdout);

    const run = await ctx.paseo(["schedule", "run-once", createdJson.id, "--json"]);
    assert.strictEqual(run.exitCode, 0, run.stderr);
    const runJson = JSON.parse(run.stdout);
    assert.strictEqual(runJson.status, "completed");
    assert.strictEqual(runJson.target, "agent:1313131");

    const deleted = await ctx.paseo(["schedule", "delete", createdJson.id, "--json"]);
    assert.strictEqual(deleted.exitCode, 0, deleted.stderr);
    console.log("schedule run-once reaches the agent-target execution path\n");
  }

  {
    console.log(
      "Test 1k: schedule update --json changes generic fields on an agent-target schedule",
    );
    const agentId = "00000000-0000-4000-8000-000000000006";
    const created = await ctx.paseo([
      "schedule",
      "create",
      "Original existing agent prompt",
      "--cron",
      "0 0 1 1 *",
      "--name",
      "original-agent-schedule",
      "--target",
      agentId,
      "--json",
    ]);
    assert.strictEqual(created.exitCode, 0, created.stderr);
    const createdJson = JSON.parse(created.stdout);

    const updated = await ctx.paseo([
      "schedule",
      "update",
      createdJson.id,
      "--name",
      "updated-agent-schedule",
      "--prompt",
      "Updated existing agent prompt",
      "--json",
    ]);
    assert.strictEqual(updated.exitCode, 0, updated.stderr);
    const updatedJson = JSON.parse(updated.stdout);
    assert.strictEqual(updatedJson.name, "updated-agent-schedule");
    assert.strictEqual(updatedJson.prompt, "Updated existing agent prompt");
    assert.deepStrictEqual(updatedJson.target, { type: "agent", agentId });

    const deleted = await ctx.paseo(["schedule", "delete", createdJson.id, "--json"]);
    assert.strictEqual(deleted.exitCode, 0, deleted.stderr);
    console.log("schedule update changes generic agent-target fields\n");
  }

  {
    console.log(
      "Test 1l: schedule update --json rejects new-agent-only fields with INVALID_TARGET",
    );
    const created = await ctx.paseo([
      "schedule",
      "create",
      "Reject launch configuration for an existing agent",
      "--cron",
      "0 0 1 1 *",
      "--target",
      "00000000-0000-4000-8000-000000000007",
      "--json",
    ]);
    assert.strictEqual(created.exitCode, 0, created.stderr);
    const createdJson = JSON.parse(created.stdout);

    const rejected = await ctx.paseo([
      "schedule",
      "update",
      createdJson.id,
      "--provider",
      "codex",
      "--model",
      "gpt-5.4",
      "--mode",
      "full-access",
      "--cwd",
      "/tmp",
      "--json",
    ]);
    assert.notStrictEqual(rejected.exitCode, 0, "new-agent-only fields should fail");
    assert.deepStrictEqual(JSON.parse(rejected.stderr), {
      error: {
        code: "INVALID_TARGET",
        message: "--provider/--model/--mode/--cwd can only be used with a new-agent target",
      },
    });

    const deleted = await ctx.paseo(["schedule", "delete", createdJson.id, "--json"]);
    assert.strictEqual(deleted.exitCode, 0, deleted.stderr);
    console.log("schedule update rejects agent-target launch configuration\n");
  }
} finally {
  await ctx.stop();
  await rm(ctx.paseoHome, { recursive: true, force: true });
  await rm(ctx.workDir, { recursive: true, force: true });
}

console.log("=== Schedule Command Tests Passed ===");
