#!/usr/bin/env npx tsx

/**
 * Phase 14: Worktree Command Tests
 *
 * Tests the worktree commands for managing Paseo-managed git worktrees.
 * Since daemon may not be running, we test both:
 * - Help and argument parsing
 * - Graceful error handling when daemon not running
 * - All flags are accepted
 *
 * Tests:
 * - worktree --help shows subcommands
 * - worktree ls --help shows options
 * - worktree ls handles daemon not running
 * - worktree archive --help shows options
 * - worktree archive requires name argument
 * - worktree archive handles daemon not running
 */

import assert from 'node:assert'
import { $ } from 'zx'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

$.verbose = false

console.log('=== Worktree Command Tests ===\n')

// Get random port that's definitely not in use (never 6767)
const port = 10000 + Math.floor(Math.random() * 50000)
const paseoHome = await mkdtemp(join(tmpdir(), 'paseo-test-home-'))

try {
  // Test 1: worktree --help shows subcommands
  {
    console.log('Test 1: worktree --help shows subcommands')
    const result = await $`npx paseo worktree --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'worktree --help should exit 0')
    assert(result.stdout.includes('ls'), 'help should mention ls subcommand')
    assert(result.stdout.includes('archive'), 'help should mention archive subcommand')
    console.log('✓ worktree --help shows subcommands\n')
  }

  // Test 2: worktree ls --help shows options
  {
    console.log('Test 2: worktree ls --help shows options')
    const result = await $`npx paseo worktree ls --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'worktree ls --help should exit 0')
    assert(result.stdout.includes('--host'), 'help should mention --host option')
    console.log('✓ worktree ls --help shows options\n')
  }

  // Test 3: worktree ls handles daemon not running
  {
    console.log('Test 3: worktree ls handles daemon not running')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo worktree ls`.nothrow()
    // Should fail because daemon not running
    assert.notStrictEqual(result.exitCode, 0, 'should fail when daemon not running')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('daemon') ||
      output.toLowerCase().includes('connect') ||
      output.toLowerCase().includes('cannot')
    assert(hasError, 'error message should mention connection issue')
    console.log('✓ worktree ls handles daemon not running\n')
  }

  // Test 4: worktree ls with --host flag is accepted
  {
    console.log('Test 4: worktree ls with --host flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo worktree ls --host localhost:${port}`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --host flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ worktree ls with --host flag is accepted\n')
  }

  // Test 5: worktree archive --help shows options
  {
    console.log('Test 5: worktree archive --help shows options')
    const result = await $`npx paseo worktree archive --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'worktree archive --help should exit 0')
    assert(result.stdout.includes('--host'), 'help should mention --host option')
    assert(result.stdout.includes('<name>'), 'help should mention required name argument')
    console.log('✓ worktree archive --help shows options\n')
  }

  // Test 6: worktree archive requires name argument
  {
    console.log('Test 6: worktree archive requires name argument')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo worktree archive`.nothrow()
    assert.notStrictEqual(result.exitCode, 0, 'should fail without name')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('missing') ||
      output.toLowerCase().includes('required') ||
      output.toLowerCase().includes('argument')
    assert(hasError, 'error should mention missing argument')
    console.log('✓ worktree archive requires name argument\n')
  }

  // Test 7: worktree archive handles daemon not running
  {
    console.log('Test 7: worktree archive handles daemon not running')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo worktree archive test-worktree`.nothrow()
    // Should fail because daemon not running
    assert.notStrictEqual(result.exitCode, 0, 'should fail when daemon not running')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('daemon') ||
      output.toLowerCase().includes('connect') ||
      output.toLowerCase().includes('cannot')
    assert(hasError, 'error message should mention connection issue')
    console.log('✓ worktree archive handles daemon not running\n')
  }

  // Test 8: worktree archive with name and --host flag is accepted
  {
    console.log('Test 8: worktree archive with name and --host flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo worktree archive test-worktree --host localhost:${port}`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --host flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ worktree archive with name and --host flag is accepted\n')
  }

  // Test 9: -q (quiet) flag is accepted with worktree ls
  {
    console.log('Test 9: -q (quiet) flag is accepted with worktree ls')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo -q worktree ls`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept -q flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ -q (quiet) flag is accepted with worktree ls\n')
  }

  // Test 10: --json flag is accepted with worktree ls
  {
    console.log('Test 10: --json flag is accepted with worktree ls')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo worktree ls --json`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --json flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ --json flag is accepted with worktree ls\n')
  }

  // Test 11: paseo --help shows worktree subcommand
  {
    console.log('Test 11: paseo --help shows worktree subcommand')
    const result = await $`npx paseo --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'paseo --help should exit 0')
    assert(result.stdout.includes('worktree'), 'help should mention worktree subcommand')
    console.log('✓ paseo --help shows worktree subcommand\n')
  }
} finally {
  // Clean up temp directory
  await rm(paseoHome, { recursive: true, force: true })
}

console.log('=== All worktree tests passed ===')
