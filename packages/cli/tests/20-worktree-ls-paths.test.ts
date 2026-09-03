#!/usr/bin/env npx tsx

import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaseoHomePath, resolvePaseoWorktreesDir } from "../src/commands/worktree/ls.js";

console.log("=== Worktree LS Path Helper Tests ===\n");

const originalPaseoHome = process.env.PASEO_HOME;
const scratch = mkdtempSync(join(tmpdir(), "paseo-worktree-ls-paths-"));

try {
  {
    console.log("Test 1: resolves explicit PASEO_HOME when set");
    const explicitHome = join(scratch, "explicit-home");
    process.env.PASEO_HOME = explicitHome;

    assert.strictEqual(resolvePaseoHomePath(), explicitHome);
    assert.strictEqual(resolvePaseoWorktreesDir(), join(explicitHome, "worktrees"));
    console.log("✓ explicit PASEO_HOME is respected\n");
  }

  {
    console.log("Test 2: re-reads PASEO_HOME on every call");
    const laterHome = join(scratch, "later-home");
    process.env.PASEO_HOME = laterHome;

    assert.strictEqual(resolvePaseoHomePath(), laterHome);
    assert.strictEqual(resolvePaseoWorktreesDir(), join(laterHome, "worktrees"));
    console.log("✓ PASEO_HOME set after module load is picked up\n");
  }

  {
    console.log("Test 3: expands a leading tilde in PASEO_HOME");
    process.env.PASEO_HOME = "~/.paseo";

    assert.strictEqual(resolvePaseoHomePath(), join(homedir(), ".paseo"));
    assert.strictEqual(resolvePaseoWorktreesDir(), join(homedir(), ".paseo", "worktrees"));
    console.log("✓ tilde paths resolve against os.homedir()\n");
  }

  {
    console.log("Test 4: falls back to homedir/.paseo when PASEO_HOME is unset");
    delete process.env.PASEO_HOME;

    assert.strictEqual(resolvePaseoHomePath(), join(homedir(), ".paseo"));
    assert.strictEqual(resolvePaseoWorktreesDir(), join(homedir(), ".paseo", "worktrees"));
    console.log("✓ fallback home path is derived from os.homedir()\n");
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
  if (originalPaseoHome === undefined) {
    delete process.env.PASEO_HOME;
  } else {
    process.env.PASEO_HOME = originalPaseoHome;
  }
}

console.log("=== All worktree ls path helper tests passed ===");
