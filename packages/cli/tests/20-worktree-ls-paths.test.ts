#!/usr/bin/env npx tsx

import assert from "node:assert";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveHubcodeHomePath, resolveHubcodeWorktreesDir } from "../src/commands/worktree/ls.js";

console.log("=== Worktree LS Path Helper Tests ===\n");

const originalHubcodeHome = process.env.HUBCODE_HOME;

try {
  {
    console.log("Test 1: resolves explicit HUBCODE_HOME when set");
    process.env.HUBCODE_HOME = "/tmp/hubcode-explicit-home";

    assert.strictEqual(resolveHubcodeHomePath(), "/tmp/hubcode-explicit-home");
    assert.strictEqual(resolveHubcodeWorktreesDir(), "/tmp/hubcode-explicit-home/worktrees");
    console.log("\u2713 explicit HUBCODE_HOME is respected\n");
  }

  {
    console.log("Test 2: falls back to homedir/.hubcode when HUBCODE_HOME is unset");
    delete process.env.HUBCODE_HOME;

    assert.strictEqual(resolveHubcodeHomePath(), join(homedir(), ".hubcode"));
    assert.strictEqual(resolveHubcodeWorktreesDir(), join(homedir(), ".hubcode", "worktrees"));
    console.log("\u2713 fallback home path is derived from os.homedir()\n");
  }
} finally {
  if (originalHubcodeHome === undefined) {
    delete process.env.HUBCODE_HOME;
  } else {
    process.env.HUBCODE_HOME = originalHubcodeHome;
  }
}

console.log("=== All worktree ls path helper tests passed ===");
