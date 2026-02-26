#!/usr/bin/env npx tsx

import assert from 'node:assert'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveJunctionHomePath, resolveJunctionWorktreesDir } from '../src/commands/worktree/ls.js'

console.log('=== Worktree LS Path Helper Tests ===\n')

const originalJunctionHome = process.env.JUNCTION_HOME

try {
  {
    console.log('Test 1: resolves explicit JUNCTION_HOME when set')
    process.env.JUNCTION_HOME = '/tmp/junction-explicit-home'

    assert.strictEqual(resolveJunctionHomePath(), '/tmp/junction-explicit-home')
    assert.strictEqual(resolveJunctionWorktreesDir(), '/tmp/junction-explicit-home/worktrees')
    console.log('\u2713 explicit JUNCTION_HOME is respected\n')
  }

  {
    console.log('Test 2: falls back to homedir/.junction when JUNCTION_HOME is unset')
    delete process.env.JUNCTION_HOME

    assert.strictEqual(resolveJunctionHomePath(), join(homedir(), '.junction'))
    assert.strictEqual(resolveJunctionWorktreesDir(), join(homedir(), '.junction', 'worktrees'))
    console.log('\u2713 fallback home path is derived from os.homedir()\n')
  }
} finally {
  if (originalJunctionHome === undefined) {
    delete process.env.JUNCTION_HOME
  } else {
    process.env.JUNCTION_HOME = originalJunctionHome
  }
}

console.log('=== All worktree ls path helper tests passed ===')
