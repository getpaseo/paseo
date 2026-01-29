#!/usr/bin/env npx tsx

/**
 * Phase 7: Logs Command Tests
 *
 * Tests the logs command - viewing agent activity/timeline (top-level command).
 * Since daemon may not be running, we test both:
 * - Help and argument parsing
 * - Graceful error handling when daemon not running
 * - All flags are accepted
 *
 * Tests:
 * - logs --help shows options
 * - logs requires ID argument
 * - logs handles daemon not running
 * - logs -f (follow) flag is accepted
 * - logs --tail flag is accepted
 */

import assert from 'node:assert'
import { $ } from 'zx'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

$.verbose = false

console.log('=== Logs Command Tests ===\n')

// Get random port that's definitely not in use (never 6767)
const port = 10000 + Math.floor(Math.random() * 50000)
const paseoHome = await mkdtemp(join(tmpdir(), 'paseo-test-home-'))

try {
  // Test 1: logs --help shows options
  {
    console.log('Test 1: logs --help shows options')
    const result = await $`npx paseo logs --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'logs --help should exit 0')
    assert(result.stdout.includes('-f') || result.stdout.includes('--follow'), 'help should mention -f/--follow flag')
    assert(result.stdout.includes('--tail'), 'help should mention --tail option')
    assert(result.stdout.includes('--host'), 'help should mention --host option')
    assert(result.stdout.includes('<id>'), 'help should mention required id argument')
    console.log('✓ logs --help shows options\n')
  }

  // Test 2: logs requires ID argument
  {
    console.log('Test 2: logs requires ID argument')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo logs`.nothrow()
    assert.notStrictEqual(result.exitCode, 0, 'should fail without id')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('missing') ||
      output.toLowerCase().includes('required') ||
      output.toLowerCase().includes('argument') ||
      output.toLowerCase().includes('id')
    assert(hasError, 'error should mention missing argument')
    console.log('✓ logs requires ID argument\n')
  }

  // Test 3: logs handles daemon not running
  {
    console.log('Test 3: logs handles daemon not running')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo logs abc123`.nothrow()
    // Should fail because daemon not running
    assert.notStrictEqual(result.exitCode, 0, 'should fail when daemon not running')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('daemon') ||
      output.toLowerCase().includes('connect') ||
      output.toLowerCase().includes('cannot')
    assert(hasError, 'error message should mention connection issue')
    console.log('✓ logs handles daemon not running\n')
  }

  // Test 4: logs -f (follow) flag is accepted
  {
    console.log('Test 4: logs -f (follow) flag is accepted')
    // Use timeout to avoid hanging on follow mode
    const result =
      await $`timeout 1 bash -c 'PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo logs -f abc123' || true`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept -f flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ logs -f (follow) flag is accepted\n')
  }

  // Test 5: logs --follow flag is accepted
  {
    console.log('Test 5: logs --follow flag is accepted')
    const result =
      await $`timeout 1 bash -c 'PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo logs --follow abc123' || true`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --follow flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ logs --follow flag is accepted\n')
  }

  // Test 6: logs --tail flag is accepted
  {
    console.log('Test 6: logs --tail flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo logs --tail 50 abc123`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --tail flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ logs --tail flag is accepted\n')
  }

  // Test 7: logs with ID and --host flag is accepted
  {
    console.log('Test 7: logs with ID and --host flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo logs abc123 --host localhost:${port}`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --host flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ logs with ID and --host flag is accepted\n')
  }

  // Test 8: paseo --help shows logs command
  {
    console.log('Test 8: paseo --help shows logs command')
    const result = await $`npx paseo --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'paseo --help should exit 0')
    assert(result.stdout.includes('logs'), 'help should mention logs command')
    console.log('✓ paseo --help shows logs command\n')
  }

  // Test 9: -q (quiet) flag is accepted with logs
  {
    console.log('Test 9: -q (quiet) flag is accepted with logs')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo -q logs abc123`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept -q flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ -q (quiet) flag is accepted with logs\n')
  }
} finally {
  // Clean up temp directory
  await rm(paseoHome, { recursive: true, force: true })
}

console.log('=== All logs tests passed ===')
