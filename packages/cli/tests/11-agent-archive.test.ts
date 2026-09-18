#!/usr/bin/env npx tsx

/**
 * Phase 11: Agent Archive Command Tests
 *
 * Tests the agent archive command - archiving (soft-delete) agents.
 * Since daemon may not be running, we test both:
 * - Help and argument parsing
 * - Graceful error handling when daemon not running
 * - All flags are accepted
 *
 * Tests:
 * - agent archive --help shows options
 * - agent archive requires ID argument
 * - agent archive handles daemon not running
 * - agent archive --force flag is accepted
 */

import assert from "node:assert";
import { getAvailablePort } from "./helpers/network.ts";
import { createTempDirs, runPaseoCli, startTestDaemon } from "./helpers/test-daemon.ts";
import { $ } from "zx";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

$.verbose = false;

const TARGET_AGENT_ID = "11111111-2222-4333-8444-555555555555";

/**
 * A PASEO_HOME whose archive-inclusive agent listing overflows one page.
 * `fetch_agents` answers at most 200 entries, so the older unarchived agent
 * sits behind 201 newer archived ones and never appears on the first page.
 */
async function seedHomePastPageCap(
  targetAgentId: string,
): Promise<{ paseoHome: string; workDir: string }> {
  const dirs = await createTempDirs();
  const olderAt = "2026-09-03T18:29:21.949Z";
  const newerAt = "2026-09-10T12:00:00.000Z";

  const writeRecord = (record: Record<string, unknown>) =>
    writeFile(
      join(dirs.paseoHome, "agents", `${record.id as string}.json`),
      JSON.stringify(record, null, 2),
    );

  await writeRecord({
    id: targetAgentId,
    provider: "codex",
    cwd: dirs.workDir,
    createdAt: olderAt,
    updatedAt: olderAt,
    title: "finished agent",
    labels: {},
    lastStatus: "closed",
    requiresAttention: true,
    attentionReason: "finished",
  });

  await Promise.all(
    Array.from({ length: 201 }, (_unused, index) =>
      writeRecord({
        id: `aaaaaaaa-0000-4000-8000-${String(index).padStart(12, "0")}`,
        provider: "codex",
        cwd: dirs.workDir,
        createdAt: newerAt,
        updatedAt: newerAt,
        title: `archived ${index}`,
        labels: {},
        lastStatus: "closed",
        archivedAt: newerAt,
      }),
    ),
  );

  return dirs;
}

/** The CLI writes its JSON error to stderr, after any Node warnings. */
function parseJsonError(stderr: string): unknown {
  const start = stderr.indexOf("{");
  assert(start >= 0, `expected a JSON error, got: ${stderr}`);
  return JSON.parse(stderr.slice(start));
}

console.log("=== Agent Archive Command Tests ===\n");

// Allocate an unused endpoint for connection-error and argument-validation checks.
const port = await getAvailablePort();
const paseoHome = await mkdtemp(join(tmpdir(), "paseo-test-home-"));

try {
  // Test 1: agent archive --help shows options
  {
    console.log("Test 1: agent archive --help shows options");
    const result = await $`npx paseo agent archive --help`.nothrow();
    assert.strictEqual(result.exitCode, 0, "agent archive --help should exit 0");
    assert(result.stdout.includes("--force"), "help should mention --force flag");
    assert(result.stdout.includes("--host"), "help should mention --host option");
    assert(result.stdout.includes("<id>"), "help should mention required id argument");
    console.log("✓ agent archive --help shows options\n");
  }

  // Test 2: agent archive requires ID argument
  {
    console.log("Test 2: agent archive requires ID argument");
    const result =
      await $`PASEO_HOME=${paseoHome} npx paseo --host localhost:${port} agent archive`.nothrow();
    assert.notStrictEqual(result.exitCode, 0, "should fail without id");
    const output = result.stdout + result.stderr;
    const hasError =
      output.toLowerCase().includes("missing") ||
      output.toLowerCase().includes("required") ||
      output.toLowerCase().includes("argument");
    assert(hasError, "error should mention missing argument");
    console.log("✓ agent archive requires ID argument\n");
  }

  // Test 3: agent archive handles daemon not running
  {
    console.log("Test 3: agent archive handles daemon not running");
    const result =
      await $`PASEO_HOME=${paseoHome} npx paseo --host localhost:${port} agent archive abc123`.nothrow();
    // Should fail because daemon not running
    assert.notStrictEqual(result.exitCode, 0, "should fail when daemon not running");
    const output = result.stdout + result.stderr;
    const hasError =
      output.toLowerCase().includes("daemon") ||
      output.toLowerCase().includes("connect") ||
      output.toLowerCase().includes("cannot");
    assert(hasError, "error message should mention connection issue");
    console.log("✓ agent archive handles daemon not running\n");
  }

  // Test 4: agent archive --force flag is accepted
  {
    console.log("Test 4: agent archive --force flag is accepted");
    const result =
      await $`PASEO_HOME=${paseoHome} npx paseo --host localhost:${port} agent archive abc123 --force`.nothrow();
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept --force flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ agent archive --force flag is accepted\n");
  }

  // Test 5: agent archive with ID and --host flag is accepted
  {
    console.log("Test 5: agent archive with ID and --host flag is accepted");
    const result =
      await $`PASEO_HOME=${paseoHome} npx paseo --host localhost:${port} agent archive abc123 --host localhost:${port}`.nothrow();
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept --host flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ agent archive with ID and --host flag is accepted\n");
  }

  // Test 6: agent shows archive in subcommands
  {
    console.log("Test 6: agent --help shows archive subcommand");
    const result = await $`npx paseo agent --help`.nothrow();
    assert.strictEqual(result.exitCode, 0, "agent --help should exit 0");
    assert(result.stdout.includes("archive"), "help should mention archive subcommand");
    console.log("✓ agent --help shows archive subcommand\n");
  }

  // Test 7: -q (quiet) flag is accepted with agent archive
  {
    console.log("Test 7: -q (quiet) flag is accepted with agent archive");
    const result =
      await $`PASEO_HOME=${paseoHome} npx paseo --host localhost:${port} -q agent archive abc123`.nothrow();
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept -q flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ -q (quiet) flag is accepted with agent archive\n");
  }

  // Test 8: archives an agent that sits past the agent listing page cap
  {
    console.log("Test 8: archives an agent past the agent listing page cap");
    const daemon = await startTestDaemon(await seedHomePastPageCap(TARGET_AGENT_ID));
    const host = `127.0.0.1:${daemon.port}`;
    try {
      const listed = await runPaseoCli(daemon, [
        "agent",
        "ls",
        "--global",
        "--json",
        "--host",
        host,
      ]);
      assert.strictEqual(listed.exitCode, 0, listed.stderr);
      assert(
        (JSON.parse(listed.stdout) as Array<{ id: string }>).some((a) => a.id === TARGET_AGENT_ID),
        "the agent should be listed before it is archived",
      );

      const archived = await runPaseoCli(daemon, [
        "agent",
        "archive",
        TARGET_AGENT_ID,
        "--json",
        "--host",
        host,
      ]);
      assert.strictEqual(archived.exitCode, 0, archived.stdout + archived.stderr);
      const result = JSON.parse(archived.stdout) as { agentId: string; status: string };
      assert.strictEqual(result.agentId, TARGET_AGENT_ID);
      assert.strictEqual(result.status, "archived");

      const remaining = await runPaseoCli(daemon, [
        "agent",
        "ls",
        "--global",
        "--json",
        "--host",
        host,
      ]);
      assert.strictEqual(remaining.exitCode, 0, remaining.stderr);
      assert(
        !(JSON.parse(remaining.stdout) as Array<{ id: string }>).some(
          (a) => a.id === TARGET_AGENT_ID,
        ),
        "the archived agent should leave the active list",
      );

      const repeated = await runPaseoCli(daemon, [
        "agent",
        "archive",
        TARGET_AGENT_ID,
        "--json",
        "--host",
        host,
      ]);
      assert.strictEqual(repeated.exitCode, 1);
      assert.strictEqual(
        (parseJsonError(repeated.stderr) as { error: { code: string } }).error.code,
        "AGENT_ALREADY_ARCHIVED",
      );

      const missing = await runPaseoCli(daemon, [
        "agent",
        "archive",
        "no-such-agent",
        "--json",
        "--host",
        host,
      ]);
      assert.strictEqual(missing.exitCode, 1);
      assert.deepStrictEqual(parseJsonError(missing.stderr), {
        error: {
          code: "AGENT_NOT_FOUND",
          message: "Agent not found: no-such-agent",
          details: 'Use "paseo ls" to list available agents',
        },
      });
    } finally {
      await daemon.stop();
    }
    console.log("✓ archives an agent past the agent listing page cap\n");
  }
} finally {
  // Clean up temp directory
  await rm(paseoHome, { recursive: true, force: true });
}

console.log("=== All agent archive tests passed ===");
