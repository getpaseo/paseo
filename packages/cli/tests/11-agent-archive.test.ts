#!/usr/bin/env npx tsx

/**
 * Phase 11: Agent Archive Command Tests
 *
 * Tests the agent archive command - archiving (soft-delete) agents.
 * Since daemon may not be running, we test both:
 * - Help and argument parsing
 * - Graceful error handling when daemon not running
 * - All flags are accepted
 *
 * Tests:
 * - agent archive --help shows options
 * - agent archive requires ID argument
 * - agent archive handles daemon not running
 * - agent archive --force flag is accepted
 */

import assert from 'node:assert'
import { $ } from 'zx'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

$.verbose = false

console.log('=== Agent Archive Command Tests ===\n')

// Get random port that's definitely not in use (never 6767)
const port = 10000 + Math.floor(Math.random() * 50000)
const junctionHome = await mkdtemp(join(tmpdir(), 'junction-test-home-'))

try {
  // Test 1: agent archive --help shows options
  {
    console.log('Test 1: agent archive --help shows options')
    const result = await $`npx junction agent archive --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'agent archive --help should exit 0')
    assert(result.stdout.includes('--force'), 'help should mention --force flag')
    assert(result.stdout.includes('--host'), 'help should mention --host option')
    assert(result.stdout.includes('<id>'), 'help should mention required id argument')
    console.log('✓ agent archive --help shows options\n')
  }

  // Test 2: agent archive requires ID argument
  {
    console.log('Test 2: agent archive requires ID argument')
    const result =
      await $`JUNCTION_HOST=localhost:${port} JUNCTION_HOME=${junctionHome} npx junction agent archive`.nothrow()
    assert.notStrictEqual(result.exitCode, 0, 'should fail without id')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('missing') ||
      output.toLowerCase().includes('required') ||
      output.toLowerCase().includes('argument')
    assert(hasError, 'error should mention missing argument')
    console.log('✓ agent archive requires ID argument\n')
  }

  // Test 3: agent archive handles daemon not running
  {
    console.log('Test 3: agent archive handles daemon not running')
    const result =
      await $`JUNCTION_HOST=localhost:${port} JUNCTION_HOME=${junctionHome} npx junction agent archive abc123`.nothrow()
    // Should fail because daemon not running
    assert.notStrictEqual(result.exitCode, 0, 'should fail when daemon not running')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('daemon') ||
      output.toLowerCase().includes('connect') ||
      output.toLowerCase().includes('cannot')
    assert(hasError, 'error message should mention connection issue')
    console.log('✓ agent archive handles daemon not running\n')
  }

  // Test 4: agent archive --force flag is accepted
  {
    console.log('Test 4: agent archive --force flag is accepted')
    const result =
      await $`JUNCTION_HOST=localhost:${port} JUNCTION_HOME=${junctionHome} npx junction agent archive abc123 --force`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --force flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ agent archive --force flag is accepted\n')
  }

  // Test 5: agent archive with ID and --host flag is accepted
  {
    console.log('Test 5: agent archive with ID and --host flag is accepted')
    const result =
      await $`JUNCTION_HOST=localhost:${port} JUNCTION_HOME=${junctionHome} npx junction agent archive abc123 --host localhost:${port}`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --host flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ agent archive with ID and --host flag is accepted\n')
  }

  // Test 6: agent shows archive in subcommands
  {
    console.log('Test 6: agent --help shows archive subcommand')
    const result = await $`npx junction agent --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'agent --help should exit 0')
    assert(result.stdout.includes('archive'), 'help should mention archive subcommand')
    console.log('✓ agent --help shows archive subcommand\n')
  }

  // Test 7: -q (quiet) flag is accepted with agent archive
  {
    console.log('Test 7: -q (quiet) flag is accepted with agent archive')
    const result =
      await $`JUNCTION_HOST=localhost:${port} JUNCTION_HOME=${junctionHome} npx junction -q agent archive abc123`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept -q flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ -q (quiet) flag is accepted with agent archive\n')
  }
} finally {
  // Clean up temp directory
  await rm(junctionHome, { recursive: true, force: true })
}

console.log('=== All agent archive tests passed ===')
