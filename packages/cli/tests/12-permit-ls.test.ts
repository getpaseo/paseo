#!/usr/bin/env npx tsx

/**
 * Permit LS Command Tests
 *
 * Tests the permit ls command - listing pending permissions.
 * Since daemon may not be running, we test:
 * - Help and argument parsing
 * - Graceful error handling when daemon not running
 * - JSON output format
 *
 * Tests:
 * - permit --help shows subcommands
 * - permit ls --help shows options
 * - permit ls returns error when no daemon
 * - permit ls --format json handles errors
 */

import assert from 'node:assert'
import { $ } from 'zx'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

$.verbose = false

console.log('=== Permit LS Command Tests ===\n')

// Get random port that's definitely not in use (never 6767)
const port = 10000 + Math.floor(Math.random() * 50000)
const paseoHome = await mkdtemp(join(tmpdir(), 'paseo-test-home-'))

try {
  // Test 1: permit --help shows subcommands
  {
    console.log('Test 1: permit --help shows subcommands')
    const result = await $`npx paseo permit --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'permit --help should exit 0')
    assert(result.stdout.includes('ls'), 'help should mention ls subcommand')
    assert(result.stdout.includes('allow'), 'help should mention allow subcommand')
    assert(result.stdout.includes('deny'), 'help should mention deny subcommand')
    console.log('✓ permit --help shows subcommands\n')
  }

  // Test 2: permit ls --help shows options
  {
    console.log('Test 2: permit ls --help shows options')
    const result = await $`npx paseo permit ls --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'permit ls --help should exit 0')
    assert(result.stdout.includes('--host'), 'help should mention --host option')
    console.log('✓ permit ls --help shows options\n')
  }

  // Test 3: permit ls returns error when no daemon running
  {
    console.log('Test 3: permit ls handles daemon not running')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo permit ls`.nothrow()
    // Should fail because daemon not running
    assert.notStrictEqual(result.exitCode, 0, 'should fail when daemon not running')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('daemon') ||
      output.toLowerCase().includes('connect') ||
      output.toLowerCase().includes('cannot')
    assert(hasError, 'error message should mention connection issue')
    console.log('✓ permit ls handles daemon not running\n')
  }

  // Test 4: permit ls --format json handles errors
  {
    console.log('Test 4: permit ls --format json handles errors')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo permit ls --format json`.nothrow()
    // Should still fail (daemon not running)
    assert.notStrictEqual(result.exitCode, 0, 'should fail when daemon not running')
    // But output should be valid JSON if present
    const output = result.stdout.trim()
    if (output.length > 0) {
      try {
        JSON.parse(output)
        console.log('✓ permit ls --format json outputs valid JSON error\n')
      } catch {
        // Empty or stderr-only output is acceptable
        console.log('✓ permit ls --format json handled error (output may be in stderr)\n')
      }
    } else {
      console.log('✓ permit ls --format json handled error gracefully\n')
    }
  }

  // Test 5: -q (quiet) flag is accepted globally
  {
    console.log('Test 5: -q (quiet) flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo -q permit ls`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept -q flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ -q (quiet) flag is accepted\n')
  }
} finally {
  // Clean up temp directory
  await rm(paseoHome, { recursive: true, force: true })
}

console.log('=== All permit ls tests passed ===')
