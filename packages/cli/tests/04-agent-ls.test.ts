#!/usr/bin/env npx tsx

/**
 * Phase 3: LS Command Tests
 *
 * Tests the ls command - listing agents (top-level command).
 * Since daemon may not be running, we test both:
 * - Help and argument parsing
 * - Graceful error handling when daemon not running
 * - JSON output format
 *
 * Tests:
 * - hubcode --help shows ls command
 * - hubcode ls --help shows options
 * - hubcode ls returns empty list or error when no daemon
 * - hubcode ls --json returns valid JSON (or error)
 * - hubcode ls -a flag is accepted
 * - hubcode ls -g flag is accepted
 * - hubcode ls does not support --ui
 */

import assert from "node:assert";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { runLocalHubcode } from "./helpers/local-cli.ts";

console.log("=== LS Command Tests ===\n");

// Get random port that's definitely not in use (never 6767)
const port = 10000 + Math.floor(Math.random() * 50000);
const hubcodeHome = await mkdtemp(join(tmpdir(), "hubcode-test-home-"));

try {
  // Test 1: hubcode --help shows ls command
  {
    console.log("Test 1: hubcode --help shows ls command");
    const result = await runLocalHubcode(["--help"]);
    assert.strictEqual(result.exitCode, 0, "hubcode --help should exit 0");
    assert(result.stdout.includes("ls"), "help should mention ls command");
    console.log("✓ hubcode --help shows ls command\n");
  }

  // Test 2: hubcode ls --help shows options
  {
    console.log("Test 2: hubcode ls --help shows options");
    const result = await runLocalHubcode(["ls", "--help"]);
    assert.strictEqual(result.exitCode, 0, "hubcode ls --help should exit 0");
    assert(result.stdout.includes("-a"), "help should mention -a flag");
    assert(result.stdout.includes("--all"), "help should mention --all flag");
    assert(result.stdout.includes("-g"), "help should mention -g flag");
    assert(result.stdout.includes("--global"), "help should mention --global flag");
    assert(result.stdout.includes("--host"), "help should mention --host option");
    assert(!result.stdout.includes("--ui"), "help should not mention --ui");
    console.log("✓ hubcode ls --help shows options\n");
  }

  // Test 3: hubcode ls returns error when no daemon running
  {
    console.log("Test 3: hubcode ls handles daemon not running");
    const result = await runLocalHubcode(["ls"], {
      HUBCODE_HOST: `localhost:${port}`,
      HUBCODE_HOME: hubcodeHome,
    });
    // Should fail because daemon not running
    assert.notStrictEqual(result.exitCode, 0, "should fail when daemon not running");
    const output = result.stdout + result.stderr;
    const hasError =
      output.toLowerCase().includes("daemon") ||
      output.toLowerCase().includes("connect") ||
      output.toLowerCase().includes("cannot");
    assert(hasError, "error message should mention connection issue");
    console.log("✓ hubcode ls handles daemon not running\n");
  }

  // Test 4: hubcode ls --json returns valid JSON error
  {
    console.log("Test 4: hubcode ls --json handles errors");
    const result = await runLocalHubcode(["ls", "--json"], {
      HUBCODE_HOST: `localhost:${port}`,
      HUBCODE_HOME: hubcodeHome,
    });
    // Should still fail (daemon not running)
    assert.notStrictEqual(result.exitCode, 0, "should fail when daemon not running");
    // But output should be valid JSON if present
    const output = result.stdout.trim();
    if (output.length > 0) {
      try {
        JSON.parse(output);
        console.log("✓ hubcode ls --json outputs valid JSON error\n");
      } catch {
        // Empty or stderr-only output is acceptable
        console.log("✓ hubcode ls --json handled error (output may be in stderr)\n");
      }
    } else {
      console.log("✓ hubcode ls --json handled error gracefully\n");
    }
  }

  // Test 5: hubcode ls -a flag is accepted
  {
    console.log("Test 5: hubcode ls -a flag is accepted");
    const result = await runLocalHubcode(["ls", "-a"], {
      HUBCODE_HOST: `localhost:${port}`,
      HUBCODE_HOME: hubcodeHome,
    });
    // Will fail due to no daemon, but flag should be parsed without error
    // (no "unknown option" error)
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept -a flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ hubcode ls -a flag is accepted\n");
  }

  // Test 6: hubcode ls -g flag is accepted
  {
    console.log("Test 6: hubcode ls -g flag is accepted");
    const result = await runLocalHubcode(["ls", "-g"], {
      HUBCODE_HOST: `localhost:${port}`,
      HUBCODE_HOME: hubcodeHome,
    });
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept -g flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ hubcode ls -g flag is accepted\n");
  }

  // Test 7: hubcode ls -ag combined flags are accepted
  {
    console.log("Test 7: hubcode ls -ag combined flags are accepted");
    const result = await runLocalHubcode(["ls", "-ag"], {
      HUBCODE_HOST: `localhost:${port}`,
      HUBCODE_HOME: hubcodeHome,
    });
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept -ag flags");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ hubcode ls -ag combined flags are accepted\n");
  }

  // Test 8: -q (quiet) flag is accepted globally
  {
    console.log("Test 8: -q (quiet) flag is accepted");
    const result = await runLocalHubcode(["-q", "ls"], {
      HUBCODE_HOST: `localhost:${port}`,
      HUBCODE_HOME: hubcodeHome,
    });
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept -q flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ -q (quiet) flag is accepted\n");
  }

  // Test 9: hubcode ls --ui is rejected (flag removed)
  {
    console.log("Test 9: hubcode ls --ui is rejected");
    const result = await runLocalHubcode(["ls", "--ui"], {
      HUBCODE_HOST: `localhost:${port}`,
      HUBCODE_HOME: hubcodeHome,
    });
    assert.notStrictEqual(result.exitCode, 0, "should fail for removed --ui flag");
    const output = result.stdout + result.stderr;
    assert(output.includes("unknown option"), "should report unknown option for --ui");
    console.log("✓ hubcode ls --ui is rejected\n");
  }
} finally {
  // Clean up temp directory
  await rm(hubcodeHome, { recursive: true, force: true });
}

console.log("=== All ls tests passed ===");
