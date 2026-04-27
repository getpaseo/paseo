#!/usr/bin/env npx tsx

/**
 * Phase 5: Send Command Tests
 *
 * Tests the send command - sending messages to existing agents (top-level command).
 * Since daemon may not be running, we test both:
 * - Help and argument parsing
 * - Graceful error handling when daemon not running
 * - All flags are accepted
 *
 * Tests:
 * - send --help shows options
 * - send requires id and prompt arguments
 * - send handles daemon not running
 * - send --no-wait flag is accepted
 * - agent shows send in subcommands
 */

import assert from "node:assert";
import { $ } from "zx";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

$.verbose = false;

console.log("=== Send Command Tests ===\n");

// Get random port that's definitely not in use (never 6767)
const port = 10000 + Math.floor(Math.random() * 50000);
const hubcodeHome = await mkdtemp(join(tmpdir(), "hubcode-test-home-"));
const promptFilePath = join(hubcodeHome, "send-prompt.txt");
await writeFile(promptFilePath, "prompt from file");

try {
  // Test 1: send --help shows options
  {
    console.log("Test 1: send --help shows options");
    const result = await $`npx hubcode send --help`.nothrow();
    assert.strictEqual(result.exitCode, 0, "send --help should exit 0");
    assert(result.stdout.includes("--prompt"), "help should mention --prompt option");
    assert(result.stdout.includes("--prompt-file"), "help should mention --prompt-file option");
    assert(result.stdout.includes("--no-wait"), "help should mention --no-wait flag");
    assert(result.stdout.includes("--host"), "help should mention --host option");
    assert(result.stdout.includes("<id>"), "help should mention id argument");
    assert(result.stdout.includes("[prompt]"), "help should mention optional prompt argument");
    console.log("  help should mention --prompt option");
    console.log("  help should mention --prompt-file option");
    console.log("  help should mention --no-wait flag");
    console.log("  help should mention --host option");
    console.log("  help should mention <id> argument");
    console.log("  help should mention [prompt] argument");
    console.log("✓ send --help shows options\n");
  }

  // Test 2: send requires id argument
  {
    console.log("Test 2: send requires id argument");
    const result =
      await $`HUBCODE_HOST=localhost:${port} HUBCODE_HOME=${hubcodeHome} npx hubcode send`.nothrow();
    assert.notStrictEqual(result.exitCode, 0, "should fail without id");
    const output = result.stdout + result.stderr;
    // Commander should complain about missing argument
    const hasMissingArg =
      output.toLowerCase().includes("missing") ||
      output.toLowerCase().includes("required") ||
      output.toLowerCase().includes("argument");
    assert(hasMissingArg, "error should mention missing argument");
    console.log("✓ send requires id argument\n");
  }

  // Test 3: send requires prompt argument
  {
    console.log("Test 3: send requires prompt argument");
    const result =
      await $`HUBCODE_HOST=localhost:${port} HUBCODE_HOME=${hubcodeHome} npx hubcode send abc123`.nothrow();
    assert.notStrictEqual(result.exitCode, 0, "should fail without prompt");
    const output = result.stdout + result.stderr;
    // Commander should complain about missing argument
    const hasMissingArg =
      output.toLowerCase().includes("missing") ||
      output.toLowerCase().includes("required") ||
      output.toLowerCase().includes("argument");
    assert(hasMissingArg, "error should mention missing argument");
    console.log("✓ send requires prompt argument\n");
  }

  // Test 4: send handles daemon not running
  {
    console.log("Test 4: send handles daemon not running");
    const result =
      await $`HUBCODE_HOST=localhost:${port} HUBCODE_HOME=${hubcodeHome} npx hubcode send abc123 "test prompt"`.nothrow();
    // Should fail because daemon not running
    assert.notStrictEqual(result.exitCode, 0, "should fail when daemon not running");
    const output = result.stdout + result.stderr;
    const hasError =
      output.toLowerCase().includes("daemon") ||
      output.toLowerCase().includes("connect") ||
      output.toLowerCase().includes("cannot");
    assert(hasError, "error message should mention connection issue");
    console.log("✓ send handles daemon not running\n");
  }

  // Test 5: send --no-wait flag is accepted
  {
    console.log("Test 5: send --no-wait flag is accepted");
    const result =
      await $`HUBCODE_HOST=localhost:${port} HUBCODE_HOME=${hubcodeHome} npx hubcode send --no-wait abc123 "test prompt"`.nothrow();
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept --no-wait flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ send --no-wait flag is accepted\n");
  }

  // Test 5b: send --prompt flag is accepted
  {
    console.log("Test 5b: send --prompt flag is accepted");
    const result =
      await $`HUBCODE_HOST=localhost:${port} HUBCODE_HOME=${hubcodeHome} npx hubcode send --prompt "test prompt" abc123`.nothrow();
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept --prompt flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ send --prompt flag is accepted\n");
  }

  // Test 5c: send --prompt-file flag is accepted
  {
    console.log("Test 5c: send --prompt-file flag is accepted");
    const result =
      await $`HUBCODE_HOST=localhost:${port} HUBCODE_HOME=${hubcodeHome} npx hubcode send --prompt-file ${promptFilePath} abc123`.nothrow();
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept --prompt-file flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ send --prompt-file flag is accepted\n");
  }

  // Test 6: send --host flag is accepted
  {
    console.log("Test 6: send --host flag is accepted");
    const result =
      await $`HUBCODE_HOME=${hubcodeHome} npx hubcode send --host localhost:${port} abc123 "test prompt"`.nothrow();
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept --host flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ send --host flag is accepted\n");
  }

  // Test 7: -q (quiet) flag is accepted with send
  {
    console.log("Test 7: -q (quiet) flag is accepted with send");
    const result =
      await $`HUBCODE_HOST=localhost:${port} HUBCODE_HOME=${hubcodeHome} npx hubcode -q send --no-wait abc123 "test prompt"`.nothrow();
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept -q flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ -q (quiet) flag is accepted with send\n");
  }

  // Test 8: Combined flags work together
  {
    console.log("Test 8: Combined flags work together");
    const result =
      await $`HUBCODE_HOST=localhost:${port} HUBCODE_HOME=${hubcodeHome} npx hubcode -q send --no-wait abc123 "Run the linter"`.nothrow();
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept all combined flags");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ Combined flags work together\n");
  }

  // Test 8b: conflicting prompt sources are rejected
  {
    console.log("Test 8b: conflicting prompt sources are rejected");
    const result =
      await $`HUBCODE_HOST=localhost:${port} HUBCODE_HOME=${hubcodeHome} npx hubcode send abc123 "positional prompt" --prompt "flag prompt"`.nothrow();
    assert.notStrictEqual(result.exitCode, 0, "should fail for conflicting prompt sources");
    const output = result.stdout + result.stderr;
    assert(
      output.includes("Provide exactly one of prompt argument, --prompt, or --prompt-file"),
      "should explain conflicting prompt sources",
    );
    console.log("✓ conflicting prompt sources are rejected\n");
  }

  // Test 9: hubcode --help shows send command
  {
    console.log("Test 9: hubcode --help shows send command");
    const result = await $`npx hubcode --help`.nothrow();
    assert.strictEqual(result.exitCode, 0, "hubcode --help should exit 0");
    assert(result.stdout.includes("send"), "help should mention send command");
    console.log("✓ hubcode --help shows send command\n");
  }

  // Test 10: ID prefix syntax is mentioned in help
  {
    console.log("Test 10: send command description mentions ID");
    const result = await $`npx hubcode send --help`.nothrow();
    assert.strictEqual(result.exitCode, 0, "send --help should exit 0");
    const hasIdMention =
      result.stdout.toLowerCase().includes("id") || result.stdout.toLowerCase().includes("prefix");
    assert(hasIdMention, "help should mention ID or prefix");
    console.log("✓ send command description mentions ID\n");
  }
} finally {
  // Clean up temp directory
  await rm(hubcodeHome, { recursive: true, force: true });
}

console.log("=== All send tests passed ===");
