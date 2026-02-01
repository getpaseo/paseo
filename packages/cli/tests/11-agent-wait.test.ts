#!/usr/bin/env npx tsx

/**
 * Phase 11: Wait Command Tests
 *
 * Tests the wait command - waiting for an agent to become idle (top-level command).
 * Since daemon may not be running, we test both:
 * - Help and argument parsing
 * - Graceful error handling when daemon not running
 * - All flags are accepted
 *
 * Tests:
 * - wait --help shows options
 * - wait requires id argument
 * - wait handles daemon not running
 * - wait --timeout flag is accepted
 * - wait --host flag is accepted
 * - agent shows wait in subcommands
 */

import assert from 'node:assert'
import { $ } from 'zx'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

$.verbose = false

console.log('=== Wait Command Tests ===\n')

// Get random port that's definitely not in use (never 6767)
const port = 10000 + Math.floor(Math.random() * 50000)
const paseoHome = await mkdtemp(join(tmpdir(), 'paseo-test-home-'))

try {
  // Test 1: wait --help shows options
  {
    console.log('Test 1: wait --help shows options')
    const result = await $`npx paseo wait --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'wait --help should exit 0')
    assert(result.stdout.includes('--host'), 'help should mention --host option')
    assert(result.stdout.includes('--timeout'), 'help should mention --timeout option')
    assert(result.stdout.includes('<id>'), 'help should mention id argument')
    console.log('  help should mention --host option')
    console.log('  help should mention --timeout option')
    console.log('  help should mention <id> argument')
    console.log('wait --help shows options\n')
  }

  // Test 2: wait requires id argument
  {
    console.log('Test 2: wait requires id argument')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo wait`.nothrow()
    assert.notStrictEqual(result.exitCode, 0, 'should fail without id')
    const output = result.stdout + result.stderr
    // Commander should complain about missing argument
    const hasMissingArg =
      output.toLowerCase().includes('missing') ||
      output.toLowerCase().includes('required') ||
      output.toLowerCase().includes('argument')
    assert(hasMissingArg, 'error should mention missing argument')
    console.log('wait requires id argument\n')
  }

  // Test 3: wait handles daemon not running
  {
    console.log('Test 3: wait handles daemon not running')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo wait abc123`.nothrow()
    // Should fail because daemon not running
    assert.notStrictEqual(result.exitCode, 0, 'should fail when daemon not running')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('daemon') ||
      output.toLowerCase().includes('connect') ||
      output.toLowerCase().includes('cannot')
    assert(hasError, 'error message should mention connection issue')
    console.log('wait handles daemon not running\n')
  }

  // Test 4: wait --timeout flag is accepted
  {
    console.log('Test 4: wait --timeout flag is accepted')
    const result =
      await $`PASEO_HOME=${paseoHome} npx paseo wait --timeout 30 --host localhost:${port} abc123`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --timeout flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('wait --timeout flag is accepted\n')
  }

  // Test 5: wait --host flag is accepted
  {
    console.log('Test 5: wait --host flag is accepted')
    const result =
      await $`PASEO_HOME=${paseoHome} npx paseo wait --host localhost:${port} abc123`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --host flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('wait --host flag is accepted\n')
  }

  // Test 6: -q (quiet) flag is accepted with wait
  {
    console.log('Test 6: -q (quiet) flag is accepted with wait')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo -q wait abc123`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept -q flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('-q (quiet) flag is accepted with wait\n')
  }

  // Test 7: --json flag is accepted with wait
  {
    console.log('Test 7: --json flag is accepted with wait')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo wait abc123 --json`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --json flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('--json flag is accepted with wait\n')
  }

  // Test 8: --format yaml flag is accepted with wait
  {
    console.log('Test 8: --format yaml flag is accepted with wait')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo --format yaml wait abc123`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --format yaml flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('--format yaml flag is accepted with wait\n')
  }

  // Test 9: paseo --help shows wait command
  {
    console.log('Test 9: paseo --help shows wait command')
    const result = await $`npx paseo --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'paseo --help should exit 0')
    assert(result.stdout.includes('wait'), 'help should mention wait command')
    console.log('paseo --help shows wait command\n')
  }

  // Test 10: wait command description is helpful
  {
    console.log('Test 10: wait command description is helpful')
    const result = await $`npx paseo wait --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'wait --help should exit 0')
    const hasDescription =
      result.stdout.toLowerCase().includes('wait') ||
      result.stdout.toLowerCase().includes('idle')
    assert(hasDescription, 'help should describe what wait does')
    console.log('wait command description is helpful\n')
  }

  // Test 11: ID prefix syntax is mentioned in help
  {
    console.log('Test 11: wait command mentions ID')
    const result = await $`npx paseo wait --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'wait --help should exit 0')
    const hasIdMention =
      result.stdout.toLowerCase().includes('id') ||
      result.stdout.toLowerCase().includes('prefix')
    assert(hasIdMention, 'help should mention ID or prefix')
    console.log('wait command mentions ID\n')
  }

  // Test 12: timeout option has default value documented
  {
    console.log('Test 12: timeout option has default value documented')
    const result = await $`npx paseo wait --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'wait --help should exit 0')
    const hasDefault =
      result.stdout.includes('600') || result.stdout.toLowerCase().includes('default')
    assert(hasDefault, 'help should mention timeout default value')
    console.log('timeout option has default value documented\n')
  }
} finally {
  // Clean up temp directory
  await rm(paseoHome, { recursive: true, force: true })
}

console.log('=== All wait tests passed ===')
