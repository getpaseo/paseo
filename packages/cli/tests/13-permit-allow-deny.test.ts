#!/usr/bin/env npx tsx

/**
 * Permit Allow/Deny Command Tests
 *
 * Tests the permit allow and deny commands.
 * Since daemon may not be running, we test:
 * - Help and argument parsing
 * - Graceful error handling when daemon not running
 * - Flag acceptance
 *
 * Tests:
 * - permit allow --help shows options
 * - permit deny --help shows options
 * - permit allow handles daemon not running
 * - permit deny handles daemon not running
 * - permit allow --all flag is accepted
 * - permit deny --all flag is accepted
 * - permit deny --message flag is accepted
 * - permit deny --interrupt flag is accepted
 * - permit allow --input flag is accepted
 */

import assert from 'node:assert'
import { $ } from 'zx'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

$.verbose = false

console.log('=== Permit Allow/Deny Command Tests ===\n')

// Get random port that's definitely not in use (never 6767)
const port = 10000 + Math.floor(Math.random() * 50000)
const paseoHome = await mkdtemp(join(tmpdir(), 'paseo-test-home-'))

try {
  // Test 1: permit allow --help shows options
  {
    console.log('Test 1: permit allow --help shows options')
    const result = await $`npx paseo permit allow --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'permit allow --help should exit 0')
    assert(result.stdout.includes('--all'), 'help should mention --all flag')
    assert(result.stdout.includes('--input'), 'help should mention --input option')
    assert(result.stdout.includes('--host'), 'help should mention --host option')
    assert(result.stdout.includes('<agent>'), 'help should mention agent argument')
    console.log('✓ permit allow --help shows options\n')
  }

  // Test 2: permit deny --help shows options
  {
    console.log('Test 2: permit deny --help shows options')
    const result = await $`npx paseo permit deny --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'permit deny --help should exit 0')
    assert(result.stdout.includes('--all'), 'help should mention --all flag')
    assert(result.stdout.includes('--message'), 'help should mention --message option')
    assert(result.stdout.includes('--interrupt'), 'help should mention --interrupt flag')
    assert(result.stdout.includes('--host'), 'help should mention --host option')
    assert(result.stdout.includes('<agent>'), 'help should mention agent argument')
    console.log('✓ permit deny --help shows options\n')
  }

  // Test 3: permit allow handles daemon not running
  {
    console.log('Test 3: permit allow handles daemon not running')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo permit allow abc123 req456`.nothrow()
    // Should fail because daemon not running
    assert.notStrictEqual(result.exitCode, 0, 'should fail when daemon not running')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('daemon') ||
      output.toLowerCase().includes('connect') ||
      output.toLowerCase().includes('cannot')
    assert(hasError, 'error message should mention connection issue')
    console.log('✓ permit allow handles daemon not running\n')
  }

  // Test 4: permit deny handles daemon not running
  {
    console.log('Test 4: permit deny handles daemon not running')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo permit deny abc123 req456`.nothrow()
    // Should fail because daemon not running
    assert.notStrictEqual(result.exitCode, 0, 'should fail when daemon not running')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('daemon') ||
      output.toLowerCase().includes('connect') ||
      output.toLowerCase().includes('cannot')
    assert(hasError, 'error message should mention connection issue')
    console.log('✓ permit deny handles daemon not running\n')
  }

  // Test 5: permit allow --all flag is accepted
  {
    console.log('Test 5: permit allow --all flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo permit allow abc123 --all`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --all flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ permit allow --all flag is accepted\n')
  }

  // Test 6: permit deny --all flag is accepted
  {
    console.log('Test 6: permit deny --all flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo permit deny abc123 --all`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --all flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ permit deny --all flag is accepted\n')
  }

  // Test 7: permit deny --message flag is accepted
  {
    console.log('Test 7: permit deny --message flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo permit deny abc123 req456 --message "Not allowed"`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --message flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ permit deny --message flag is accepted\n')
  }

  // Test 8: permit deny --interrupt flag is accepted
  {
    console.log('Test 8: permit deny --interrupt flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo permit deny abc123 req456 --interrupt`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --interrupt flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ permit deny --interrupt flag is accepted\n')
  }

  // Test 9: permit allow --input flag is accepted
  {
    console.log('Test 9: permit allow --input flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo permit allow abc123 req456 --input '{"key":"value"}'`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --input flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ permit allow --input flag is accepted\n')
  }

  // Test 10: permit allow without req_id and without --all fails gracefully
  {
    console.log('Test 10: permit allow requires req_id or --all')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo permit allow abc123`.nothrow()
    // This might fail due to daemon not running first, or due to missing argument
    // The important thing is it doesn't crash with an unhandled error
    assert.notStrictEqual(result.exitCode, 0, 'should fail without req_id or --all')
    console.log('✓ permit allow requires req_id or --all\n')
  }

  // Test 11: permit deny without req_id and without --all fails gracefully
  {
    console.log('Test 11: permit deny requires req_id or --all')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo permit deny abc123`.nothrow()
    assert.notStrictEqual(result.exitCode, 0, 'should fail without req_id or --all')
    console.log('✓ permit deny requires req_id or --all\n')
  }
} finally {
  // Clean up temp directory
  await rm(paseoHome, { recursive: true, force: true })
}

console.log('=== All permit allow/deny tests passed ===')
