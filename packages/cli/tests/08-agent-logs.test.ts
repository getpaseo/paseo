#!/usr/bin/env npx tsx

/**
 * Phase 7: Agent Logs Command Tests
 *
 * Tests the agent logs command - viewing agent activity/timeline.
 * Since daemon may not be running, we test both:
 * - Help and argument parsing
 * - Graceful error handling when daemon not running
 * - All flags are accepted
 *
 * Tests:
 * - agent logs --help shows options
 * - agent logs requires ID argument
 * - agent logs handles daemon not running
 * - agent logs -f (follow) flag is accepted
 * - agent logs --tail flag is accepted
 */

import assert from 'node:assert'
import { $ } from 'zx'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

$.verbose = false

console.log('=== Agent Logs Command Tests ===\n')

// Get random port that's definitely not in use (never 6767)
const port = 10000 + Math.floor(Math.random() * 50000)
const paseoHome = await mkdtemp(join(tmpdir(), 'paseo-test-home-'))

try {
  // Test 1: agent logs --help shows options
  {
    console.log('Test 1: agent logs --help shows options')
    const result = await $`npx paseo agent logs --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'agent logs --help should exit 0')
    assert(result.stdout.includes('-f') || result.stdout.includes('--follow'), 'help should mention -f/--follow flag')
    assert(result.stdout.includes('--tail'), 'help should mention --tail option')
    assert(result.stdout.includes('--host'), 'help should mention --host option')
    assert(result.stdout.includes('<id>'), 'help should mention required id argument')
    console.log('✓ agent logs --help shows options\n')
  }

  // Test 2: agent logs requires ID argument
  {
    console.log('Test 2: agent logs requires ID argument')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent logs`.nothrow()
    assert.notStrictEqual(result.exitCode, 0, 'should fail without id')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('missing') ||
      output.toLowerCase().includes('required') ||
      output.toLowerCase().includes('argument') ||
      output.toLowerCase().includes('id')
    assert(hasError, 'error should mention missing argument')
    console.log('✓ agent logs requires ID argument\n')
  }

  // Test 3: agent logs handles daemon not running
  {
    console.log('Test 3: agent logs handles daemon not running')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent logs abc123`.nothrow()
    // Should fail because daemon not running
    assert.notStrictEqual(result.exitCode, 0, 'should fail when daemon not running')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('daemon') ||
      output.toLowerCase().includes('connect') ||
      output.toLowerCase().includes('cannot')
    assert(hasError, 'error message should mention connection issue')
    console.log('✓ agent logs handles daemon not running\n')
  }

  // Test 4: agent logs -f (follow) flag is accepted
  {
    console.log('Test 4: agent logs -f (follow) flag is accepted')
    // Use timeout to avoid hanging on follow mode
    const result =
      await $`timeout 1 bash -c 'PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent logs -f abc123' || true`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept -f flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ agent logs -f (follow) flag is accepted\n')
  }

  // Test 5: agent logs --follow flag is accepted
  {
    console.log('Test 5: agent logs --follow flag is accepted')
    const result =
      await $`timeout 1 bash -c 'PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent logs --follow abc123' || true`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --follow flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ agent logs --follow flag is accepted\n')
  }

  // Test 6: agent logs --tail flag is accepted
  {
    console.log('Test 6: agent logs --tail flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent logs --tail 50 abc123`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --tail flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ agent logs --tail flag is accepted\n')
  }

  // Test 7: agent logs with ID and --host flag is accepted
  {
    console.log('Test 7: agent logs with ID and --host flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent logs abc123 --host localhost:${port}`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --host flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ agent logs with ID and --host flag is accepted\n')
  }

  // Test 8: agent shows logs in subcommands
  {
    console.log('Test 8: agent --help shows logs subcommand')
    const result = await $`npx paseo agent --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'agent --help should exit 0')
    assert(result.stdout.includes('logs'), 'help should mention logs subcommand')
    console.log('✓ agent --help shows logs subcommand\n')
  }

  // Test 9: -q (quiet) flag is accepted with agent logs
  {
    console.log('Test 9: -q (quiet) flag is accepted with agent logs')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo -q agent logs abc123`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept -q flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ -q (quiet) flag is accepted with agent logs\n')
  }
} finally {
  // Clean up temp directory
  await rm(paseoHome, { recursive: true, force: true })
}

console.log('=== All agent logs tests passed ===')
