#!/usr/bin/env npx tsx

/**
 * Phase 6: Stop Command Tests
 *
 * Tests the stop command - stopping agents (cancel if running, then terminate) (top-level command).
 * Since daemon may not be running, we test both:
 * - Help and argument parsing
 * - Graceful error handling when daemon not running
 * - All flags are accepted
 *
 * Tests:
 * - stop --help shows options
 * - stop requires ID, --all, or --cwd
 * - stop handles daemon not running
 * - stop --all flag is accepted
 * - stop --cwd flag is accepted
 */

import assert from 'node:assert'
import { $ } from 'zx'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

$.verbose = false

console.log('=== Stop Command Tests ===\n')

// Get random port that's definitely not in use (never 6767)
const port = 10000 + Math.floor(Math.random() * 50000)
const paseoHome = await mkdtemp(join(tmpdir(), 'paseo-test-home-'))

try {
  // Test 1: stop --help shows options
  {
    console.log('Test 1: stop --help shows options')
    const result = await $`npx paseo stop --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'stop --help should exit 0')
    assert(result.stdout.includes('--all'), 'help should mention --all flag')
    assert(result.stdout.includes('--cwd'), 'help should mention --cwd option')
    assert(result.stdout.includes('--host'), 'help should mention --host option')
    assert(result.stdout.includes('[id]'), 'help should mention optional id argument')
    console.log('✓ stop --help shows options\n')
  }

  // Test 2: stop requires ID, --all, or --cwd
  {
    console.log('Test 2: stop requires ID, --all, or --cwd')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo stop`.nothrow()
    assert.notStrictEqual(result.exitCode, 0, 'should fail without id, --all, or --cwd')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('missing') ||
      output.toLowerCase().includes('required') ||
      output.toLowerCase().includes('argument') ||
      output.toLowerCase().includes('id')
    assert(hasError, 'error should mention missing argument')
    console.log('✓ stop requires ID, --all, or --cwd\n')
  }

  // Test 3: stop handles daemon not running
  {
    console.log('Test 3: stop handles daemon not running')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo stop abc123`.nothrow()
    // Should fail because daemon not running
    assert.notStrictEqual(result.exitCode, 0, 'should fail when daemon not running')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('daemon') ||
      output.toLowerCase().includes('connect') ||
      output.toLowerCase().includes('cannot')
    assert(hasError, 'error message should mention connection issue')
    console.log('✓ stop handles daemon not running\n')
  }

  // Test 4: stop --all flag is accepted
  {
    console.log('Test 4: stop --all flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo stop --all`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --all flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ stop --all flag is accepted\n')
  }

  // Test 5: stop --cwd flag is accepted
  {
    console.log('Test 5: stop --cwd flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo stop --cwd /tmp`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --cwd flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ stop --cwd flag is accepted\n')
  }

  // Test 6: stop with ID and --host flag is accepted
  {
    console.log('Test 6: stop with ID and --host flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo stop abc123 --host localhost:${port}`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --host flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ stop with ID and --host flag is accepted\n')
  }

  // Test 7: paseo --help shows stop command
  {
    console.log('Test 7: paseo --help shows stop command')
    const result = await $`npx paseo --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'paseo --help should exit 0')
    assert(result.stdout.includes('stop'), 'help should mention stop command')
    console.log('✓ paseo --help shows stop command\n')
  }

  // Test 8: -q (quiet) flag is accepted with stop
  {
    console.log('Test 8: -q (quiet) flag is accepted with stop')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo -q stop abc123`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept -q flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ -q (quiet) flag is accepted with stop\n')
  }
} finally {
  // Clean up temp directory
  await rm(paseoHome, { recursive: true, force: true })
}

console.log('=== All stop tests passed ===')
