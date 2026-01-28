#!/usr/bin/env npx tsx

/**
 * Phase 10: Agent Mode Command Tests
 *
 * Tests the agent mode command - changing and listing agent operational modes.
 * Since daemon may not be running, we test both:
 * - Help and argument parsing
 * - Graceful error handling when daemon not running
 * - All flags are accepted
 *
 * Tests:
 * - agent mode --help shows options
 * - agent mode requires id argument
 * - agent mode handles daemon not running
 * - agent mode --list flag is accepted
 */

import assert from 'node:assert'
import { $ } from 'zx'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

$.verbose = false

console.log('=== Agent Mode Command Tests ===\n')

// Get random port that's definitely not in use (never 6767)
const port = 10000 + Math.floor(Math.random() * 50000)
const paseoHome = await mkdtemp(join(tmpdir(), 'paseo-test-home-'))

try {
  // Test 1: agent mode --help shows options
  {
    console.log('Test 1: agent mode --help shows options')
    const result = await $`npx paseo agent mode --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'agent mode --help should exit 0')
    assert(result.stdout.includes('--list'), 'help should mention --list flag')
    assert(result.stdout.includes('--host'), 'help should mention --host option')
    assert(result.stdout.includes('<id>'), 'help should mention id argument')
    assert(result.stdout.includes('[mode]'), 'help should mention optional mode argument')
    console.log('✓ agent mode --help shows options\n')
  }

  // Test 2: agent mode requires id argument
  {
    console.log('Test 2: agent mode requires id argument')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent mode`.nothrow()
    assert.notStrictEqual(result.exitCode, 0, 'should fail without id')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('missing') ||
      output.toLowerCase().includes('required') ||
      output.toLowerCase().includes('argument') ||
      output.toLowerCase().includes('id')
    assert(hasError, 'error should mention missing argument')
    console.log('✓ agent mode requires id argument\n')
  }

  // Test 3: agent mode handles daemon not running
  {
    console.log('Test 3: agent mode handles daemon not running')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent mode abc123 bypass`.nothrow()
    // Should fail because daemon not running
    assert.notStrictEqual(result.exitCode, 0, 'should fail when daemon not running')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('daemon') ||
      output.toLowerCase().includes('connect') ||
      output.toLowerCase().includes('cannot')
    assert(hasError, 'error message should mention connection issue')
    console.log('✓ agent mode handles daemon not running\n')
  }

  // Test 4: agent mode --list flag is accepted
  {
    console.log('Test 4: agent mode --list flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent mode --list abc123`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --list flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ agent mode --list flag is accepted\n')
  }

  // Test 5: agent mode with ID and --host flag is accepted
  {
    console.log('Test 5: agent mode with ID and --host flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent mode abc123 plan --host localhost:${port}`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --host flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ agent mode with ID and --host flag is accepted\n')
  }

  // Test 6: agent shows mode in subcommands
  {
    console.log('Test 6: agent --help shows mode subcommand')
    const result = await $`npx paseo agent --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'agent --help should exit 0')
    assert(result.stdout.includes('mode'), 'help should mention mode subcommand')
    console.log('✓ agent --help shows mode subcommand\n')
  }

  // Test 7: -q (quiet) flag is accepted with agent mode
  {
    console.log('Test 7: -q (quiet) flag is accepted with agent mode')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo -q agent mode abc123 bypass`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept -q flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ -q (quiet) flag is accepted with agent mode\n')
  }

  // Test 8: agent mode requires mode argument when not using --list
  {
    console.log('Test 8: agent mode requires mode argument when not using --list')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent mode abc123`.nothrow()
    // Should fail because mode is required unless --list is specified
    assert.notStrictEqual(result.exitCode, 0, 'should fail without mode argument')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('missing') ||
      output.toLowerCase().includes('required') ||
      output.toLowerCase().includes('mode') ||
      output.toLowerCase().includes('daemon') // If daemon error comes first, that's also valid
    assert(hasError, 'error should mention missing mode or connection issue')
    console.log('✓ agent mode requires mode argument when not using --list\n')
  }
} finally {
  // Clean up temp directory
  await rm(paseoHome, { recursive: true, force: true })
}

console.log('=== All agent mode tests passed ===')
