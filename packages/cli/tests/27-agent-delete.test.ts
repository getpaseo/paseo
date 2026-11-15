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
import { createTempDirs, runPaseoCli, startTestDaemon } from "./helpers/test-daemon.ts";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

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

  {
    console.log("Test 9: delete reports AGENT_NOT_FOUND for an unknown ID");
    const daemon = await startTestDaemon();
    try {
      const result = await runPaseoCli(daemon, [
        "agent",
        "delete",
        "does-not-exist",
        "--host",
        `127.0.0.1:${daemon.port}`,
        "--json",
      ]);
      assert.notStrictEqual(result.exitCode, 0, "delete should fail for an unknown ID");
      const { error } = JSON.parse(result.stderr);
      assert.strictEqual(error.code, "AGENT_NOT_FOUND", result.stderr);
      assert.match(error.details, /paseo ls/);
    } finally {
      await daemon.stop();
    }
    console.log("✓ delete reports AGENT_NOT_FOUND for an unknown ID\n");
  }

  {
    console.log("Test 10: a missing full ID does not delete an agent titled with it");
    const missingId = "11111111-2222-4333-8444-555555555555";
    const titledId = "c9a97e5d-4a92-4646-a016-53032146d0a1";
    const dirs = await createTempDirs();
    await writeFile(
      join(dirs.paseoHome, "agents", `${titledId}.json`),
      JSON.stringify(
        {
          id: titledId,
          provider: "codex",
          cwd: dirs.workDir,
          createdAt: "2026-09-03T18:29:21.949Z",
          updatedAt: "2026-09-03T18:29:21.949Z",
          title: missingId,
          labels: {},
          lastStatus: "closed",
        },
        null,
        2,
      ),
    );
    const daemon = await startTestDaemon(dirs);
    const host = `127.0.0.1:${daemon.port}`;
    try {
      for (const command of ["inspect", "delete"]) {
        const result = await runPaseoCli(daemon, [
          "agent",
          command,
          missingId,
          "--json",
          "--host",
          host,
        ]);
        assert.strictEqual(result.exitCode, 1, `${command}: ${result.stdout}`);
        assert.strictEqual(
          JSON.parse(result.stderr).error.code,
          "AGENT_NOT_FOUND",
          `${command}: ${result.stderr}`,
        );
      }

      const titled = await runPaseoCli(daemon, [
        "agent",
        "inspect",
        titledId,
        "--json",
        "--host",
        host,
      ]);
      assert.strictEqual(titled.exitCode, 0, titled.stderr);
      assert.strictEqual(JSON.parse(titled.stdout).Id, titledId);
    } finally {
      await daemon.stop();
    }
    console.log("✓ a missing full ID does not delete an agent titled with it\n");
  }
} finally {
  await rm(paseoHome, { recursive: true, force: true });
}

console.log("=== All delete tests passed ===");
