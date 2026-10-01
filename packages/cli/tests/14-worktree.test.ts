#!/usr/bin/env npx tsx

import assert from "node:assert";
import { getAvailablePort } from "./helpers/network.ts";
import { $ } from "zx";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

$.verbose = false;

console.log("=== Worktree Command Tests ===\n");
const port = await getAvailablePort();
const paseoHome = await mkdtemp(join(tmpdir(), "paseo-test-home-"));

try {
  {
    console.log("Test 1: worktree --help shows subcommands");
    const result = await $`npx pandaos worktree --help`.nothrow();
    assert.strictEqual(result.exitCode, 0, "worktree --help should exit 0");
    assert(result.stdout.includes("ls"), "help should mention ls subcommand");
    assert(result.stdout.includes("archive"), "help should mention archive subcommand");
    console.log("✓ worktree --help shows subcommands\n");
  }
  {
    console.log("Test 2: worktree ls --help shows options");
    const result = await $`npx pandaos worktree ls --help`.nothrow();
    assert.strictEqual(result.exitCode, 0, "worktree ls --help should exit 0");
    assert(result.stdout.includes("--host"), "help should mention --host option");
    console.log("✓ worktree ls --help shows options\n");
  }
  {
    console.log("Test 3: worktree ls handles daemon not running");
    const result =
      await $`PASEO_HOME=${paseoHome} npx pandaos --host localhost:${port} worktree ls`.nothrow();
    assert.notStrictEqual(result.exitCode, 0, "should fail when daemon not running");
    const output = result.stdout + result.stderr;
    const hasError =
      output.toLowerCase().includes("daemon") ||
      output.toLowerCase().includes("connect") ||
      output.toLowerCase().includes("cannot");
    assert(hasError, "error message should mention connection issue");
    console.log("✓ worktree ls handles daemon not running\n");
  }
  {
    console.log("Test 4: worktree ls with --host flag is accepted");
    const result =
      await $`PASEO_HOME=${paseoHome} npx pandaos --host localhost:${port} worktree ls --host localhost:${port}`.nothrow();
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept --host flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ worktree ls with --host flag is accepted\n");
  }
  {
    console.log("Test 5: worktree archive --help shows options");
    const result = await $`npx pandaos worktree archive --help`.nothrow();
    assert.strictEqual(result.exitCode, 0, "worktree archive --help should exit 0");
    assert(result.stdout.includes("--host"), "help should mention --host option");
    assert(result.stdout.includes("<name>"), "help should mention required name argument");
    console.log("✓ worktree archive --help shows options\n");
  }
  {
    console.log("Test 6: worktree archive requires name argument");
    const result =
      await $`PASEO_HOME=${paseoHome} npx pandaos --host localhost:${port} worktree archive`.nothrow();
    assert.notStrictEqual(result.exitCode, 0, "should fail without name");
    const output = result.stdout + result.stderr;
    const hasError =
      output.toLowerCase().includes("missing") ||
      output.toLowerCase().includes("required") ||
      output.toLowerCase().includes("argument");
    assert(hasError, "error should mention missing argument");
    console.log("✓ worktree archive requires name argument\n");
  }
  {
    console.log("Test 7: worktree archive handles daemon not running");
    const result =
      await $`PASEO_HOME=${paseoHome} npx pandaos --host localhost:${port} worktree archive test-worktree`.nothrow();
    assert.notStrictEqual(result.exitCode, 0, "should fail when daemon not running");
    const output = result.stdout + result.stderr;
    const hasError =
      output.toLowerCase().includes("daemon") ||
      output.toLowerCase().includes("connect") ||
      output.toLowerCase().includes("cannot");
    assert(hasError, "error message should mention connection issue");
    console.log("✓ worktree archive handles daemon not running\n");
  }
  {
    console.log("Test 8: worktree archive with name and --host flag is accepted");
    const result =
      await $`PASEO_HOME=${paseoHome} npx pandaos --host localhost:${port} worktree archive test-worktree --host localhost:${port}`.nothrow();
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept --host flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ worktree archive with name and --host flag is accepted\n");
  }
  {
    console.log("Test 9: -q (quiet) flag is accepted with worktree ls");
    const result =
      await $`PASEO_HOME=${paseoHome} npx pandaos --host localhost:${port} -q worktree ls`.nothrow();
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept -q flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ -q (quiet) flag is accepted with worktree ls\n");
  }
  {
    console.log("Test 10: --json flag is accepted with worktree ls");
    const result =
      await $`PASEO_HOME=${paseoHome} npx pandaos --host localhost:${port} worktree ls --json`.nothrow();
    const output = result.stdout + result.stderr;
    assert(!output.includes("unknown option"), "should accept --json flag");
    assert(!output.includes("error: option"), "should not have option parsing error");
    console.log("✓ --json flag is accepted with worktree ls\n");
  }
  {
    console.log("Test 11: pandaos --help hides worktree compatibility command");
    const result = await $`npx pandaos --help`.nothrow();
    assert.strictEqual(result.exitCode, 0, "pandaos --help should exit 0");
    assert(!result.stdout.includes("worktree"), "help should not advertise worktree subcommand");
    console.log("✓ pandaos --help hides worktree compatibility command\n");
  }
} finally {
  await rm(paseoHome, { recursive: true, force: true });
}

console.log("=== All worktree tests passed ===");
