#!/usr/bin/env npx tsx

/**
 * Phase 16: Agent Update Command Tests
 *
 * Tests the agent update command for metadata updates.
 * Since daemon may not be running, we test:
 * - Help and argument parsing
 * - Validation for required update fields
 * - Graceful daemon connection errors
 */

import assert from "node:assert";
import { $ } from "zx";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { getAvailablePort } from "./helpers/network.ts";

$.verbose = false;

console.log("=== Agent Update Command Tests ===\n");

// Resolve an available local port so daemon-not-running checks stay deterministic.
const port = await getAvailablePort();
const paseoHome = await mkdtemp(join(tmpdir(), "paseo-test-home-"));

try {
  // Test 1: agent update --help shows options
  {
    console.log("Test 1: agent update --help shows options");
    const result = await $`npx paseo agent update --help`.nothrow();
    assert.strictEqual(result.exitCode, 0, "agent update --help should exit 0");
    assert(result.stdout.includes("--name"), "help should mention --name flag");
    assert(result.stdout.includes("--label"), "help should mention --label flag");
    assert(result.stdout.includes("--thinking"), "help should mention --thinking flag");
    assert(result.stdout.includes("--host"), "help should mention --host option");
    assert(result.stdout.includes("<id>"), "help should mention required id argument");
    console.log("✓ agent update --help shows options\n");
  }

  // Test 2: agent update requires ID argument
  {
    console.log("Test 2: agent update requires ID argument");
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent update --name "New Name"`.nothrow();
    assert.notStrictEqual(result.exitCode, 0, "should fail without id");
    const output = result.stdout + result.stderr;
    const hasError =
      output.toLowerCase().includes("missing") ||
      output.toLowerCase().includes("required") ||
      output.toLowerCase().includes("argument") ||
      output.toLowerCase().includes("id");
    assert(hasError, "error should mention missing argument");
    console.log("✓ agent update requires ID argument\n");
  }

  // Test 3: agent update requires at least one update field
  {
    console.log("Test 3: agent update requires update field");
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent update abc123`.nothrow();
    assert.notStrictEqual(result.exitCode, 0, "should fail without --name/--label");
    const output = result.stdout + result.stderr;
    const hasError =
      output.toLowerCase().includes("nothing to update") ||
      output.toLowerCase().includes("name") ||
      output.toLowerCase().includes("label");
    assert(hasError, "error should mention missing update fields");
    console.log("✓ agent update requires update field\n");
  }

  // Test 4: agent update handles daemon not running
  {
    console.log("Test 4: agent update handles daemon not running");
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent update abc123 --name "Renamed Agent"`.nothrow();
    assert.notStrictEqual(result.exitCode, 0, "should fail when daemon not running");
    const output = result.stdout + result.stderr;
    const hasError =
      output.toLowerCase().includes("daemon") ||
      output.toLowerCase().includes("connect") ||
      output.toLowerCase().includes("cannot");
    assert(hasError, "error should mention connection issue");
    console.log("✓ agent update handles daemon not running\n");
  }

  // Test 5: agent update accepts multiple/comma-separated labels
  {
    console.log("Test 5: agent update accepts multi-label syntax");
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent update abc123 --label surface=workspace,area=frontend --label priority=high`.nothrow();
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept --label flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ agent update accepts multi-label syntax\n");
  }

  // Test 6: agent --help shows update subcommand
  {
    console.log("Test 6: agent --help shows update subcommand");
    const result = await $`npx paseo agent --help`.nothrow();
    assert.strictEqual(result.exitCode, 0, "agent --help should exit 0");
    assert(result.stdout.includes("update"), "help should mention update subcommand");
    console.log("✓ agent --help shows update subcommand\n");
  }

  // Test 7: agent update accepts thinking as an update field
  {
    console.log("Test 7: agent update accepts thinking as an update field");
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent update abc123 --thinking high`.nothrow();
    const output = result.stdout + result.stderr;
    assert(!output.includes("Nothing to update"), "should treat --thinking as an update field");
    console.log("✓ agent update accepts thinking as an update field\n");
  }

  // Test 8: thinking cannot be combined with metadata updates
  {
    console.log("Test 8: thinking cannot be combined with metadata updates");
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent update abc123 --name renamed --thinking high`.nothrow();
    assert.notStrictEqual(result.exitCode, 0, "should reject a combined update");
    const output = result.stdout + result.stderr;
    assert(
      output.includes("--thinking cannot be combined with --name or --label"),
      "should explain that thinking and metadata updates are separate operations",
    );
    console.log("✓ thinking cannot be combined with metadata updates\n");
  }
} finally {
  // Clean up temp directory
  await rm(paseoHome, { recursive: true, force: true });
}

console.log("=== All agent update tests passed ===");
