#!/usr/bin/env npx tsx

/**
 * Phase 6: Agent Stop Command Tests
 *
 * Tests the agent stop command - stopping agents (cancel if running, then terminate).
 * Since daemon may not be running, we test both:
 * - Help and argument parsing
 * - Graceful error handling when daemon not running
 * - All flags are accepted
 *
 * Tests:
 * - agent stop --help shows options
 * - agent stop requires ID, --all, or --cwd
 * - agent stop handles daemon not running
 * - agent stop --all flag is accepted
 * - agent stop --cwd flag is accepted
 */

import assert from 'node:assert'
import { $ } from 'zx'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

$.verbose = false

console.log('=== Agent Stop Command Tests ===\n')

// Get random port that's definitely not in use (never 6767)
const port = 10000 + Math.floor(Math.random() * 50000)
const paseoHome = await mkdtemp(join(tmpdir(), 'paseo-test-home-'))

try {
  // Test 1: agent stop --help shows options
  {
    console.log('Test 1: agent stop --help shows options')
    const result = await $`npx paseo agent stop --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'agent stop --help should exit 0')
    assert(result.stdout.includes('--all'), 'help should mention --all flag')
    assert(result.stdout.includes('--cwd'), 'help should mention --cwd option')
    assert(result.stdout.includes('--host'), 'help should mention --host option')
    assert(result.stdout.includes('[id]'), 'help should mention optional id argument')
    console.log('✓ agent stop --help shows options\n')
  }

  // Test 2: agent stop requires ID, --all, or --cwd
  {
    console.log('Test 2: agent stop requires ID, --all, or --cwd')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent stop`.nothrow()
    assert.notStrictEqual(result.exitCode, 0, 'should fail without id, --all, or --cwd')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('missing') ||
      output.toLowerCase().includes('required') ||
      output.toLowerCase().includes('argument') ||
      output.toLowerCase().includes('id')
    assert(hasError, 'error should mention missing argument')
    console.log('✓ agent stop requires ID, --all, or --cwd\n')
  }

  // Test 3: agent stop handles daemon not running
  {
    console.log('Test 3: agent stop handles daemon not running')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent stop abc123`.nothrow()
    // Should fail because daemon not running
    assert.notStrictEqual(result.exitCode, 0, 'should fail when daemon not running')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('daemon') ||
      output.toLowerCase().includes('connect') ||
      output.toLowerCase().includes('cannot')
    assert(hasError, 'error message should mention connection issue')
    console.log('✓ agent stop handles daemon not running\n')
  }

  // Test 4: agent stop --all flag is accepted
  {
    console.log('Test 4: agent stop --all flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent stop --all`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --all flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ agent stop --all flag is accepted\n')
  }

  // Test 5: agent stop --cwd flag is accepted
  {
    console.log('Test 5: agent stop --cwd flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent stop --cwd /tmp`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --cwd flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ agent stop --cwd flag is accepted\n')
  }

  // Test 6: agent stop with ID and --host flag is accepted
  {
    console.log('Test 6: agent stop with ID and --host flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent stop abc123 --host localhost:${port}`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --host flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ agent stop with ID and --host flag is accepted\n')
  }

  // Test 7: agent shows stop in subcommands
  {
    console.log('Test 7: agent --help shows stop subcommand')
    const result = await $`npx paseo agent --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'agent --help should exit 0')
    assert(result.stdout.includes('stop'), 'help should mention stop subcommand')
    console.log('✓ agent --help shows stop subcommand\n')
  }

  // Test 8: -q (quiet) flag is accepted with agent stop
  {
    console.log('Test 8: -q (quiet) flag is accepted with agent stop')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo -q agent stop abc123`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept -q flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ -q (quiet) flag is accepted with agent stop\n')
  }
} finally {
  // Clean up temp directory
  await rm(paseoHome, { recursive: true, force: true })
}

console.log('=== All agent stop tests passed ===')
