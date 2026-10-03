#!/usr/bin/env npx tsx

/**
 * Delete Command Tests
 *
 * Tests the delete command - hard-deleting agents (interrupt if running first).
 * Since daemon may not be running, we test both:
 * - Help and argument parsing
 * - Graceful error handling when daemon not running
 * - All flags are accepted
 */

import assert from "node:assert";
import { runLocalPaseo } from "./helpers/local-cli.ts";
import { getAvailablePort } from "./helpers/network.ts";
import { mkdir, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createTestPaseoDaemon } from "../../server/src/server/test-utils/paseo-daemon.js";
import { DaemonClient } from "../../server/src/server/test-utils/daemon-client.js";

console.log("=== Delete Command Tests ===\n");

const port = await getAvailablePort();
const paseoHome = await mkdtemp(join(tmpdir(), "paseo-delete-test-home-"));

async function runCli(args: string[]) {
  return runLocalPaseo(["--host", `localhost:${port}`, ...args], { PASEO_HOME: paseoHome });
}

async function runDelete(args: string[]) {
  return runCli(["delete", ...args]);
}

try {
  {
    console.log("Test 1: delete --help shows options");
    const result = await runDelete(["--help"]);
    assert.strictEqual(result.exitCode, 0, "delete --help should exit 0");
    assert(result.stdout.includes("--all"), "help should mention --all flag");
    assert(result.stdout.includes("--cwd"), "help should mention --cwd option");
    assert(result.stdout.includes("--host"), "help should mention --host option");
    assert(result.stdout.includes("[id]"), "help should mention optional id argument");
    console.log("✓ delete --help shows options\n");
  }

  {
    console.log("Test 2: delete requires ID, --all, or --cwd");
    const result = await runDelete([]);
    assert.notStrictEqual(result.exitCode, 0, "should fail without id, --all, or --cwd");
    const output = result.stdout + result.stderr;
    const hasError =
      output.toLowerCase().includes("missing") ||
      output.toLowerCase().includes("required") ||
      output.toLowerCase().includes("argument") ||
      output.toLowerCase().includes("id");
    assert(hasError, "error should mention missing argument");
    console.log("✓ delete requires ID, --all, or --cwd\n");
  }

  {
    console.log("Test 3: delete handles daemon not running");
    const result = await runDelete(["abc123"]);
    assert.notStrictEqual(result.exitCode, 0, "should fail when daemon not running");
    const output = result.stdout + result.stderr;
    const hasError =
      output.toLowerCase().includes("daemon") ||
      output.toLowerCase().includes("connect") ||
      output.toLowerCase().includes("cannot");
    assert(hasError, "error message should mention connection issue");
    console.log("✓ delete handles daemon not running\n");
  }

  {
    console.log("Test 4: delete --all flag is accepted");
    const result = await runDelete(["--all"]);
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept --all flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ delete --all flag is accepted\n");
  }

  {
    console.log("Test 5: delete --cwd flag is accepted");
    const result = await runDelete(["--cwd", "/tmp"]);
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept --cwd flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ delete --cwd flag is accepted\n");
  }

  {
    console.log("Test 6: delete with ID and --host flag is accepted");
    const result = await runDelete(["abc123", "--host", `localhost:${port}`]);
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept --host flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ delete with ID and --host flag is accepted\n");
  }

  {
    console.log("Test 7: paseo --help shows delete command");
    const result = await runCli(["--help"]);
    assert.strictEqual(result.exitCode, 0, "paseo --help should exit 0");
    assert(result.stdout.includes("delete"), "help should mention delete command");
    console.log("✓ paseo --help shows delete command\n");
  }

  {
    console.log("Test 8: -q (quiet) flag is accepted with delete");
    const result = await runCli(["-q", "delete", "abc123"]);
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept -q flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ -q (quiet) flag is accepted with delete\n");
  }
} finally {
  await rm(paseoHome, { recursive: true, force: true });
}

const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
const client = new DaemonClient({
  url: `ws://127.0.0.1:${daemon.port}/ws`,
  appVersion: "0.10.0",
});
try {
  await client.connect();
  await client.fetchAgents({ subscribe: {} });
  const active = await client.createAgent({
    provider: "codex",
    cwd: daemon.staticDir,
    title: "Active",
  });
  const archived = await client.createAgent({
    provider: "codex",
    cwd: daemon.staticDir,
    title: "Archived",
  });
  await client.archiveAgent(archived.id);
  const result = await runLocalPaseo([
    "--host",
    `127.0.0.1:${daemon.port}`,
    "agent",
    "delete",
    "--all",
    "--json",
  ]);
  assert.strictEqual(result.exitCode, 0, result.stderr);
  const deleted = JSON.parse(result.stdout);
  assert.strictEqual(deleted.deletedCount, 2);
  assert.deepStrictEqual(deleted.agentIds.sort(), [active.id, archived.id].sort());
  const remaining = await client.fetchAgents({ filter: { includeArchived: true } });
  assert.deepStrictEqual(remaining.entries, []);
  console.log("✓ --all removes active and archived agents from daemon history");

  const nestedCwd = join(daemon.staticDir, "nested");
  await mkdir(nestedCwd);
  const scoped = await client.createAgent({ provider: "codex", cwd: daemon.staticDir });
  const nested = await client.createAgent({ provider: "codex", cwd: nestedCwd });
  const outside = await client.createAgent({ provider: "codex", cwd: daemon.paseoHome });
  await client.archiveAgent(nested.id);
  await client.archiveAgent(outside.id);
  const scopedResult = await runLocalPaseo([
    "--host",
    `127.0.0.1:${daemon.port}`,
    "agent",
    "delete",
    "--cwd",
    daemon.staticDir,
    "--json",
  ]);
  assert.strictEqual(scopedResult.exitCode, 0, scopedResult.stderr);
  const scopedDeleted = JSON.parse(scopedResult.stdout);
  assert.strictEqual(scopedDeleted.deletedCount, 2);
  assert.deepStrictEqual(scopedDeleted.agentIds.sort(), [scoped.id, nested.id].sort());
  const outsideRemaining = await client.fetchAgents({ filter: { includeArchived: true } });
  assert.deepStrictEqual(
    outsideRemaining.entries.map((entry) => entry.agent.id),
    [outside.id],
  );
  console.log("✓ --cwd removes archived descendants and preserves agents outside the directory");
} finally {
  await client.close();
  await daemon.close();
}

console.log("=== All delete tests passed ===");
