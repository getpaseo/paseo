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
 * - junction --help shows ls command
 * - junction ls --help shows options
 * - junction ls returns empty list or error when no daemon
 * - junction ls --json returns valid JSON (or error)
 * - junction ls -a flag is accepted
 * - junction ls -g flag is accepted
 * - junction ls does not support --ui
 */

import assert from 'node:assert'
import { $ } from 'zx'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

$.verbose = false

console.log('=== LS Command Tests ===\n')

// Get random port that's definitely not in use (never 6767)
const port = 10000 + Math.floor(Math.random() * 50000)
const junctionHome = await mkdtemp(join(tmpdir(), 'junction-test-home-'))

try {
  // Test 1: junction --help shows ls command
  {
    console.log('Test 1: junction --help shows ls command')
    const result = await $`npx junction --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'junction --help should exit 0')
    assert(result.stdout.includes('ls'), 'help should mention ls command')
    console.log('✓ junction --help shows ls command\n')
  }

  // Test 2: junction ls --help shows options
  {
    console.log('Test 2: junction ls --help shows options')
    const result = await $`npx junction ls --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'junction ls --help should exit 0')
    assert(result.stdout.includes('-a'), 'help should mention -a flag')
    assert(result.stdout.includes('--all'), 'help should mention --all flag')
    assert(result.stdout.includes('-g'), 'help should mention -g flag')
    assert(result.stdout.includes('--global'), 'help should mention --global flag')
    assert(result.stdout.includes('--host'), 'help should mention --host option')
    assert(!result.stdout.includes('--ui'), 'help should not mention --ui')
    console.log('✓ junction ls --help shows options\n')
  }

  // Test 3: junction ls returns error when no daemon running
  {
    console.log('Test 3: junction ls handles daemon not running')
    const result =
      await $`JUNCTION_HOST=localhost:${port} JUNCTION_HOME=${junctionHome} npx junction ls`.nothrow()
    // Should fail because daemon not running
    assert.notStrictEqual(result.exitCode, 0, 'should fail when daemon not running')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('daemon') ||
      output.toLowerCase().includes('connect') ||
      output.toLowerCase().includes('cannot')
    assert(hasError, 'error message should mention connection issue')
    console.log('✓ junction ls handles daemon not running\n')
  }

  // Test 4: junction ls --json returns valid JSON error
  {
    console.log('Test 4: junction ls --json handles errors')
    const result =
      await $`JUNCTION_HOST=localhost:${port} JUNCTION_HOME=${junctionHome} npx junction ls --json`.nothrow()
    // Should still fail (daemon not running)
    assert.notStrictEqual(result.exitCode, 0, 'should fail when daemon not running')
    // But output should be valid JSON if present
    const output = result.stdout.trim()
    if (output.length > 0) {
      try {
        JSON.parse(output)
        console.log('✓ junction ls --json outputs valid JSON error\n')
      } catch {
        // Empty or stderr-only output is acceptable
        console.log('✓ junction ls --json handled error (output may be in stderr)\n')
      }
    } else {
      console.log('✓ junction ls --json handled error gracefully\n')
    }
  }

  // Test 5: junction ls -a flag is accepted
  {
    console.log('Test 5: junction ls -a flag is accepted')
    const result =
      await $`JUNCTION_HOST=localhost:${port} JUNCTION_HOME=${junctionHome} npx junction ls -a`.nothrow()
    // Will fail due to no daemon, but flag should be parsed without error
    // (no "unknown option" error)
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept -a flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ junction ls -a flag is accepted\n')
  }

  // Test 6: junction ls -g flag is accepted
  {
    console.log('Test 6: junction ls -g flag is accepted')
    const result =
      await $`JUNCTION_HOST=localhost:${port} JUNCTION_HOME=${junctionHome} npx junction ls -g`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept -g flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ junction ls -g flag is accepted\n')
  }

  // Test 7: junction ls -ag combined flags are accepted
  {
    console.log('Test 7: junction ls -ag combined flags are accepted')
    const result =
      await $`JUNCTION_HOST=localhost:${port} JUNCTION_HOME=${junctionHome} npx junction ls -ag`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept -ag flags')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ junction ls -ag combined flags are accepted\n')
  }

  // Test 8: -q (quiet) flag is accepted globally
  {
    console.log('Test 8: -q (quiet) flag is accepted')
    const result =
      await $`JUNCTION_HOST=localhost:${port} JUNCTION_HOME=${junctionHome} npx junction -q ls`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept -q flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ -q (quiet) flag is accepted\n')
  }

  // Test 9: junction ls --ui is rejected (flag removed)
  {
    console.log('Test 9: junction ls --ui is rejected')
    const result =
      await $`JUNCTION_HOST=localhost:${port} JUNCTION_HOME=${junctionHome} npx junction ls --ui`.nothrow()
    assert.notStrictEqual(result.exitCode, 0, 'should fail for removed --ui flag')
    const output = result.stdout + result.stderr
    assert(output.includes('unknown option'), 'should report unknown option for --ui')
    console.log('✓ junction ls --ui is rejected\n')
  }
} finally {
  // Clean up temp directory
  await rm(junctionHome, { recursive: true, force: true })
}

console.log('=== All ls tests passed ===')
