#!/usr/bin/env npx tsx

/**
 * Phase 7: Logs Command Tests
 *
 * Tests the logs command - viewing agent activity/timeline (top-level command).
 * Since daemon may not be running, we test both:
 * - Help and argument parsing
 * - Graceful error handling when daemon not running
 * - All flags are accepted
 *
 * Tests:
 * - logs --help shows options
 * - logs requires ID argument
 * - logs handles daemon not running
 * - logs -f (follow) flag is accepted
 * - logs --tail flag is accepted
 */

import assert from "node:assert";
import { getAvailablePort } from "./helpers/network.ts";
import { $, type ProcessPromise } from "zx";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createDaemonTestContext } from "../../server/src/server/test-utils/daemon-test-context.ts";
import { createTestAgentClients } from "../../server/src/server/test-utils/fake-agent-client.ts";
import type { AgentStreamEvent } from "@getpaseo/protocol/agent-types";
import { runLocalPaseo } from "./helpers/local-cli.ts";

$.verbose = false;

function waitForCliOutput(child: ProcessPromise, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(text)) {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`CLI did not print ${text}:\n${output}`));
    }, 20_000);
    child.stdout.on("data", onData);
    void child.then(
      (result) => {
        cleanup();
        return reject(new Error(`CLI exited before ${text}:\n${result.stderr}`));
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

console.log("=== Logs Command Tests ===\n");

// Allocate an unused endpoint for connection-error and argument-validation checks.
const port = await getAvailablePort();
const paseoHome = await mkdtemp(join(tmpdir(), "paseo-test-home-"));

try {
  // Test 1: logs --help shows options
  {
    console.log("Test 1: logs --help shows options");
    const result = await $`npx paseo logs --help`.nothrow();
    assert.strictEqual(result.exitCode, 0, "logs --help should exit 0");
    assert(
      result.stdout.includes("-f") || result.stdout.includes("--follow"),
      "help should mention -f/--follow flag",
    );
    assert(result.stdout.includes("--tail"), "help should mention --tail option");
    assert(result.stdout.includes("--host"), "help should mention --host option");
    assert(result.stdout.includes("<id>"), "help should mention required id argument");
    console.log("✓ logs --help shows options\n");
  }

  // Test 2: logs requires ID argument
  {
    console.log("Test 2: logs requires ID argument");
    const result =
      await $`PASEO_HOME=${paseoHome} npx paseo --host localhost:${port} logs`.nothrow();
    assert.notStrictEqual(result.exitCode, 0, "should fail without id");
    const output = result.stdout + result.stderr;
    const hasError =
      output.toLowerCase().includes("missing") ||
      output.toLowerCase().includes("required") ||
      output.toLowerCase().includes("argument") ||
      output.toLowerCase().includes("id");
    assert(hasError, "error should mention missing argument");
    console.log("✓ logs requires ID argument\n");
  }

  // Test 3: logs handles daemon not running
  {
    console.log("Test 3: logs handles daemon not running");
    const result =
      await $`PASEO_HOME=${paseoHome} npx paseo --host localhost:${port} logs abc123`.nothrow();
    // Should fail because daemon not running
    assert.notStrictEqual(result.exitCode, 0, "should fail when daemon not running");
    const output = result.stdout + result.stderr;
    const hasError =
      output.toLowerCase().includes("daemon") ||
      output.toLowerCase().includes("connect") ||
      output.toLowerCase().includes("cannot");
    assert(hasError, "error message should mention connection issue");
    console.log("✓ logs handles daemon not running\n");
  }

  // Test 4: logs -f (follow) flag is accepted
  {
    console.log("Test 4: logs -f (follow) flag is accepted");
    // Use timeout to avoid hanging on follow mode
    const result =
      await $`timeout 1 bash -c 'PASEO_HOME=${paseoHome} npx paseo --host localhost:${port} logs -f abc123' || true`.nothrow();
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept -f flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ logs -f (follow) flag is accepted\n");
  }

  // Test 5: logs --follow flag is accepted
  {
    console.log("Test 5: logs --follow flag is accepted");
    const result =
      await $`timeout 1 bash -c 'PASEO_HOME=${paseoHome} npx paseo --host localhost:${port} logs --follow abc123' || true`.nothrow();
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept --follow flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ logs --follow flag is accepted\n");
  }

  // Test 6: logs --tail flag is accepted
  {
    console.log("Test 6: logs --tail flag is accepted");
    const result =
      await $`PASEO_HOME=${paseoHome} npx paseo --host localhost:${port} logs --tail 50 abc123`.nothrow();
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept --tail flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ logs --tail flag is accepted\n");
  }

  // Test 7: logs with ID and --host flag is accepted
  {
    console.log("Test 7: logs with ID and --host flag is accepted");
    const result =
      await $`PASEO_HOME=${paseoHome} npx paseo --host localhost:${port} logs abc123 --host localhost:${port}`.nothrow();
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept --host flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ logs with ID and --host flag is accepted\n");
  }

  // Test 8: paseo --help shows logs command
  {
    console.log("Test 8: paseo --help shows logs command");
    const result = await $`npx paseo --help`.nothrow();
    assert.strictEqual(result.exitCode, 0, "paseo --help should exit 0");
    assert(result.stdout.includes("logs"), "help should mention logs command");
    console.log("✓ paseo --help shows logs command\n");
  }

  // Test 9: -q (quiet) flag is accepted with logs
  {
    console.log("Test 9: -q (quiet) flag is accepted with logs");
    const result =
      await $`PASEO_HOME=${paseoHome} npx paseo --host localhost:${port} -q logs abc123`.nothrow();
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept -q flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ -q (quiet) flag is accepted with logs\n");
  }
} finally {
  // Clean up temp directory
  await rm(paseoHome, { recursive: true, force: true });
}

console.log("Test 10: --since filters logs through the real CLI and daemon");
const historyEvents: AgentStreamEvent[] = [];
const ctx = await createDaemonTestContext({
  agentClients: createTestAgentClients({ historyEvents }),
});
try {
  const agent = await ctx.client.createAgent({
    provider: "codex",
    cwd: ctx.daemon.paseoHome,
    title: "logs since",
  });
  const manager = ctx.daemon.daemon.agentManager;
  await manager.appendTimelineItem(agent.id, { type: "user_message", text: "OLD_USER" });
  await manager.appendTimelineItem(agent.id, { type: "assistant_message", text: "OLD_REPLY" });
  const host = `127.0.0.1:${ctx.daemon.port}`;
  const logs = (args: string[]) =>
    runLocalPaseo(["--host", host, ...args], {}, ctx.daemon.paseoHome);

  const baseline = await logs(["logs", agent.id]);
  assert.strictEqual(baseline.exitCode, 0, baseline.stderr);
  assert.strictEqual(baseline.stdout, "[User] OLD_USER\nOLD_REPLY\n");

  for (const command of [["logs"], ["agent", "logs"]]) {
    const result = await logs([...command, agent.id, "--since", "2100-01-01T00:00:00Z"]);
    console.log(`paseo ${command.join(" ")} <id> --since 2100-01-01T00:00:00Z`);
    console.log(`exit=${result.exitCode}\nstdout:\n${result.stdout}stderr:\n${result.stderr}`);
    assert.strictEqual(result.exitCode, 0, result.stderr);
    assert.strictEqual(result.stdout, "No activity to display.\n");
  }

  const timeline = await ctx.client.fetchAgentTimeline(agent.id, {
    direction: "tail",
    limit: 0,
    projection: "projected",
  });
  const firstTimestamp = timeline.entries[0]?.timestamp;
  assert(firstTimestamp !== undefined, "the fixture should have timestamped activity");
  for (const since of ["2000-01-01T00:00:00Z", firstTimestamp]) {
    const result = await logs(["logs", agent.id, "--since", since]);
    assert.strictEqual(result.exitCode, 0, result.stderr);
    assert.strictEqual(result.stdout, baseline.stdout);
  }

  const offset = await logs(["logs", agent.id, "--since", "2100-01-01T08:00:00+08:00"]);
  assert.strictEqual(offset.exitCode, 0, offset.stderr);
  assert.strictEqual(offset.stdout, "No activity to display.\n");

  const tail = await logs([
    "logs",
    agent.id,
    "--since",
    "2000-01-01T00:00:00Z",
    "--filter",
    "text",
    "--tail",
    "1",
  ]);
  assert.strictEqual(tail.exitCode, 0, tail.stderr);
  assert.strictEqual(tail.stdout, "OLD_REPLY\n");

  const empty = await logs(["logs", agent.id, "--since", firstTimestamp, "--tail", "0"]);
  assert.strictEqual(empty.exitCode, 0, empty.stderr);
  assert.strictEqual(empty.stdout, "");

  for (const followArgs of [[], ["--follow"]]) {
    const invalid = await runLocalPaseo([
      "--host",
      `127.0.0.1:${port}`,
      "logs",
      "missing-agent",
      "--since",
      "not-a-date",
      "--json",
      ...followArgs,
    ]);
    assert.strictEqual(invalid.exitCode, 1, invalid.stderr);
    assert.strictEqual(invalid.stdout, "");
    assert.deepStrictEqual(JSON.parse(invalid.stderr), {
      error: {
        code: "INVALID_TIMESTAMP",
        message: "Invalid --since value: not-a-date",
        details: "Use a timestamp such as 2026-01-01T00:00:00Z.",
      },
    });
  }

  console.log("Test 11: --since filters initial history in follow mode");
  const follow = logs(["logs", agent.id, "--follow", "--since", "2100-01-01T00:00:00Z"]).timeout(
    "25s",
  );
  try {
    await waitForCliOutput(follow, "--- Following logs");
  } finally {
    await follow.kill("SIGINT");
  }
  const followed = await follow;
  console.log(`follow exit=${followed.exitCode}\nstdout:\n${followed.stdout}`);
  assert.strictEqual(followed.exitCode, 0, followed.stderr);
  assert.strictEqual(followed.stdout.includes("OLD_USER"), false);
  assert.strictEqual(followed.stdout.includes("OLD_REPLY"), false);

  console.log("Test 12: --since filters live events in follow mode");
  const futureFollow = logs([
    "agent",
    "logs",
    agent.id,
    "-f",
    "--tail",
    "0",
    "--since",
    "2100-01-01T00:00:00Z",
  ]).timeout("25s");
  try {
    await waitForCliOutput(futureFollow, "--- Following logs");
    // A timestamped history replay follows the live item on the same socket.
    // Its visible output proves the CLI consumed the earlier item too.
    await Promise.all([
      waitForCliOutput(futureFollow, "AFTER_CUTOFF"),
      (async () => {
        await manager.appendTimelineItem(agent.id, {
          type: "user_message",
          text: "LIVE_BEFORE_CUTOFF",
        });
        historyEvents.push({
          type: "timeline",
          provider: "codex",
          timestamp: "2110-01-01T00:00:00Z",
          item: { type: "user_message", text: "AFTER_CUTOFF" },
        });
        await ctx.client.refreshAgent(agent.id);
      })(),
    ]);
  } finally {
    await futureFollow.kill("SIGINT");
  }
  const futureOutput = await futureFollow;
  console.log(`future follow exit=${futureOutput.exitCode}\nstdout:\n${futureOutput.stdout}`);
  assert.strictEqual(futureOutput.exitCode, 0, futureOutput.stderr);
  assert.strictEqual(futureOutput.stdout.includes("LIVE_BEFORE_CUTOFF"), false);

  console.log("Test 13: follow still prints live events after --since");
  const pastFollow = logs([
    "logs",
    agent.id,
    "--follow",
    "--tail",
    "0",
    "--filter",
    "text",
    "--since",
    "2000-01-01T00:00:00Z",
  ]).timeout("25s");
  try {
    await waitForCliOutput(pastFollow, "--- Following logs");
    await Promise.all([
      waitForCliOutput(pastFollow, "LIVE_REPLY"),
      (async () => {
        await manager.appendTimelineItem(agent.id, { type: "user_message", text: "LIVE_USER" });
        await manager.appendTimelineItem(agent.id, {
          type: "assistant_message",
          text: "LIVE_REPLY",
        });
      })(),
    ]);
  } finally {
    await pastFollow.kill("SIGINT");
  }
  const pastOutput = await pastFollow;
  console.log(`past follow exit=${pastOutput.exitCode}\nstdout:\n${pastOutput.stdout}`);
  assert.strictEqual(pastOutput.exitCode, 0, pastOutput.stderr);
  assert(pastOutput.stdout.includes("[User] LIVE_USER\nLIVE_REPLY\n"), pastOutput.stdout);
} finally {
  await ctx.cleanup();
}

console.log("=== All logs tests passed ===");
