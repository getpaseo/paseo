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
        "--cwd",
        ctx.workDir,
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
        "--cwd",
        ctx.workDir,
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
        "--cwd",
        ctx.workDir,
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
    console.log("Test 1d: schedule update clears limits with negated flags");
    const created = await ctx.paseo([
      "schedule",
      "create",
      "Review scheduled work",
      "--cron",
      "0 0 1 1 *",
      "--provider",
      "claude",
      "--cwd",
      ctx.workDir,
      "--max-runs",
      "3",
      "--expires-in",
      "1h",
      "--json",
    ]);
    assert.strictEqual(created.exitCode, 0, created.stderr);
    const { id } = JSON.parse(created.stdout);

    const inspect = async () => {
      const result = await ctx.paseo(["schedule", "inspect", id, "--json"]);
      assert.strictEqual(result.exitCode, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const initial = await inspect();
    assert.strictEqual(initial.maxRuns, 3);
    assert.strictEqual(typeof initial.expiresAt, "string");

    const renamed = await ctx.paseo([
      "schedule",
      "update",
      id,
      "--name",
      "renamed-review",
      "--json",
    ]);
    assert.strictEqual(renamed.exitCode, 0, renamed.stderr);
    const afterRename = await inspect();
    assert.strictEqual(afterRename.name, "renamed-review");
    assert.strictEqual(afterRename.maxRuns, initial.maxRuns);
    assert.strictEqual(afterRename.expiresAt, initial.expiresAt);

    const clearedMaxRuns = await ctx.paseo(["schedule", "update", id, "--no-max-runs", "--json"]);
    assert.strictEqual(clearedMaxRuns.exitCode, 0, clearedMaxRuns.stderr);
    const withoutMaxRuns = await inspect();
    assert.strictEqual(withoutMaxRuns.maxRuns, null);
    assert.strictEqual(withoutMaxRuns.expiresAt, initial.expiresAt);

    const clearedExpiration = await ctx.paseo([
      "schedule",
      "update",
      id,
      "--no-expires-in",
      "--json",
    ]);
    assert.strictEqual(clearedExpiration.exitCode, 0, clearedExpiration.stderr);
    const withoutExpiration = await inspect();
    assert.strictEqual(withoutExpiration.maxRuns, null);
    assert.strictEqual(withoutExpiration.expiresAt, null);

    const updatedLimits = await ctx.paseo([
      "schedule",
      "update",
      id,
      "--max-runs",
      "5",
      "--expires-in",
      "2h",
      "--json",
    ]);
    assert.strictEqual(updatedLimits.exitCode, 0, updatedLimits.stderr);
    const withLimits = await inspect();
    assert.strictEqual(withLimits.maxRuns, 5);
    assert.strictEqual(typeof withLimits.expiresAt, "string");

    const clearedBoth = await ctx.paseo([
      "schedule",
      "update",
      id,
      "--no-max-runs",
      "--no-expires-in",
      "--json",
    ]);
    assert.strictEqual(clearedBoth.exitCode, 0, clearedBoth.stderr);
    const withoutLimits = await inspect();
    assert.strictEqual(withoutLimits.maxRuns, null);
    assert.strictEqual(withoutLimits.expiresAt, null);

    const deleted = await ctx.paseo(["schedule", "delete", id, "--json"]);
    assert.strictEqual(deleted.exitCode, 0, deleted.stderr);
    console.log("schedule update clears limits\n");
  }

  {
    console.log("Test 1e: compatibility agent-target schedules remain deletable");
    const created = await ctx.paseo(
      [
        "schedule",
        "create",
        "Legacy heartbeat",
        "--cron",
        "0 0 1 1 *",
        "--target",
        "00000000-0000-4000-8000-000000000001",
        "--cwd",
        ctx.workDir,
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
} finally {
  await ctx.stop();
  await rm(ctx.paseoHome, { recursive: true, force: true });
  await rm(ctx.workDir, { recursive: true, force: true });
}

console.log("=== Schedule Command Tests Passed ===");
