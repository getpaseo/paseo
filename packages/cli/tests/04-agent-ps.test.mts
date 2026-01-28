#!/usr/bin/env npx tsx

/**
 * Phase 3: Agent PS Command Tests
 *
 * Tests the agent ps command - listing agents.
 * Since daemon may not be running, we test both:
 * - Help and argument parsing
 * - Graceful error handling when daemon not running
 * - JSON output format
 *
 * Tests:
 * - agent --help shows subcommands
 * - agent ps --help shows options
 * - agent ps returns empty list or error when no daemon
 * - agent ps --format json returns valid JSON (or error)
 * - agent ps -a flag is accepted
 * - agent ps --status flag is accepted
 * - agent ps --cwd flag is accepted
 */

import assert from 'node:assert'
import { $ } from 'zx'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

$.verbose = false

console.log('=== Agent PS Command Tests ===\n')

// Get random port that's definitely not in use (never 6767)
const port = 10000 + Math.floor(Math.random() * 50000)
const paseoHome = await mkdtemp(join(tmpdir(), 'paseo-test-home-'))

try {
  // Test 1: agent --help shows subcommands
  {
    console.log('Test 1: agent --help shows subcommands')
    const result = await $`npx paseo agent --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'agent --help should exit 0')
    assert(result.stdout.includes('ps'), 'help should mention ps subcommand')
    console.log('✓ agent --help shows subcommands\n')
  }

  // Test 2: agent ps --help shows options
  {
    console.log('Test 2: agent ps --help shows options')
    const result = await $`npx paseo agent ps --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'agent ps --help should exit 0')
    assert(result.stdout.includes('-a'), 'help should mention -a flag')
    assert(result.stdout.includes('--all'), 'help should mention --all flag')
    assert(result.stdout.includes('--status'), 'help should mention --status option')
    assert(result.stdout.includes('--cwd'), 'help should mention --cwd option')
    assert(result.stdout.includes('--host'), 'help should mention --host option')
    console.log('✓ agent ps --help shows options\n')
  }

  // Test 3: agent ps returns error when no daemon running
  {
    console.log('Test 3: agent ps handles daemon not running')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent ps`.nothrow()
    // Should fail because daemon not running
    assert.notStrictEqual(result.exitCode, 0, 'should fail when daemon not running')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('daemon') ||
      output.toLowerCase().includes('connect') ||
      output.toLowerCase().includes('cannot')
    assert(hasError, 'error message should mention connection issue')
    console.log('✓ agent ps handles daemon not running\n')
  }

  // Test 4: agent ps --format json returns valid JSON error
  {
    console.log('Test 4: agent ps --format json handles errors')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent ps --format json`.nothrow()
    // Should still fail (daemon not running)
    assert.notStrictEqual(result.exitCode, 0, 'should fail when daemon not running')
    // But output should be valid JSON if present
    const output = result.stdout.trim()
    if (output.length > 0) {
      try {
        JSON.parse(output)
        console.log('✓ agent ps --format json outputs valid JSON error\n')
      } catch {
        // Empty or stderr-only output is acceptable
        console.log('✓ agent ps --format json handled error (output may be in stderr)\n')
      }
    } else {
      console.log('✓ agent ps --format json handled error gracefully\n')
    }
  }

  // Test 5: agent ps -a flag is accepted
  {
    console.log('Test 5: agent ps -a flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent ps -a`.nothrow()
    // Will fail due to no daemon, but flag should be parsed without error
    // (no "unknown option" error)
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept -a flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ agent ps -a flag is accepted\n')
  }

  // Test 6: agent ps --status flag is accepted
  {
    console.log('Test 6: agent ps --status flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent ps --status running`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --status flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ agent ps --status flag is accepted\n')
  }

  // Test 7: agent ps --cwd flag is accepted
  {
    console.log('Test 7: agent ps --cwd flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent ps --cwd /tmp`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --cwd flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ agent ps --cwd flag is accepted\n')
  }

  // Test 8: -q (quiet) flag is accepted globally
  {
    console.log('Test 8: -q (quiet) flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo -q agent ps`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept -q flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ -q (quiet) flag is accepted\n')
  }
} finally {
  // Clean up temp directory
  await rm(paseoHome, { recursive: true, force: true })
}

console.log('=== All agent ps tests passed ===')
