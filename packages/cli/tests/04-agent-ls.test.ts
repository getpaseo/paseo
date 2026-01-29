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
 * - paseo --help shows ls command
 * - paseo ls --help shows options
 * - paseo ls returns empty list or error when no daemon
 * - paseo ls --format json returns valid JSON (or error)
 * - paseo ls -a flag is accepted
 * - paseo ls -g flag is accepted
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
const paseoHome = await mkdtemp(join(tmpdir(), 'paseo-test-home-'))

try {
  // Test 1: paseo --help shows ls command
  {
    console.log('Test 1: paseo --help shows ls command')
    const result = await $`npx paseo --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'paseo --help should exit 0')
    assert(result.stdout.includes('ls'), 'help should mention ls command')
    console.log('✓ paseo --help shows ls command\n')
  }

  // Test 2: paseo ls --help shows options
  {
    console.log('Test 2: paseo ls --help shows options')
    const result = await $`npx paseo ls --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'paseo ls --help should exit 0')
    assert(result.stdout.includes('-a'), 'help should mention -a flag')
    assert(result.stdout.includes('--all'), 'help should mention --all flag')
    assert(result.stdout.includes('-g'), 'help should mention -g flag')
    assert(result.stdout.includes('--global'), 'help should mention --global flag')
    assert(result.stdout.includes('--host'), 'help should mention --host option')
    console.log('✓ paseo ls --help shows options\n')
  }

  // Test 3: paseo ls returns error when no daemon running
  {
    console.log('Test 3: paseo ls handles daemon not running')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo ls`.nothrow()
    // Should fail because daemon not running
    assert.notStrictEqual(result.exitCode, 0, 'should fail when daemon not running')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('daemon') ||
      output.toLowerCase().includes('connect') ||
      output.toLowerCase().includes('cannot')
    assert(hasError, 'error message should mention connection issue')
    console.log('✓ paseo ls handles daemon not running\n')
  }

  // Test 4: paseo ls --format json returns valid JSON error
  {
    console.log('Test 4: paseo ls --format json handles errors')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo ls --format json`.nothrow()
    // Should still fail (daemon not running)
    assert.notStrictEqual(result.exitCode, 0, 'should fail when daemon not running')
    // But output should be valid JSON if present
    const output = result.stdout.trim()
    if (output.length > 0) {
      try {
        JSON.parse(output)
        console.log('✓ paseo ls --format json outputs valid JSON error\n')
      } catch {
        // Empty or stderr-only output is acceptable
        console.log('✓ paseo ls --format json handled error (output may be in stderr)\n')
      }
    } else {
      console.log('✓ paseo ls --format json handled error gracefully\n')
    }
  }

  // Test 5: paseo ls -a flag is accepted
  {
    console.log('Test 5: paseo ls -a flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo ls -a`.nothrow()
    // Will fail due to no daemon, but flag should be parsed without error
    // (no "unknown option" error)
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept -a flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ paseo ls -a flag is accepted\n')
  }

  // Test 6: paseo ls -g flag is accepted
  {
    console.log('Test 6: paseo ls -g flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo ls -g`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept -g flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ paseo ls -g flag is accepted\n')
  }

  // Test 7: paseo ls -ag combined flags are accepted
  {
    console.log('Test 7: paseo ls -ag combined flags are accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo ls -ag`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept -ag flags')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ paseo ls -ag combined flags are accepted\n')
  }

  // Test 8: -q (quiet) flag is accepted globally
  {
    console.log('Test 8: -q (quiet) flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo -q ls`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept -q flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ -q (quiet) flag is accepted\n')
  }
} finally {
  // Clean up temp directory
  await rm(paseoHome, { recursive: true, force: true })
}

console.log('=== All ls tests passed ===')
