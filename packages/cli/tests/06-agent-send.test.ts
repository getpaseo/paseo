#!/usr/bin/env npx tsx

/**
 * Phase 5: Send Command Tests
 *
 * Tests the send command - sending messages to existing agents (top-level command).
 * Since daemon may not be running, we test both:
 * - Help and argument parsing
 * - Graceful error handling when daemon not running
 * - All flags are accepted
 *
 * Tests:
 * - send --help shows options
 * - send requires id and prompt arguments
 * - send handles daemon not running
 * - send --no-wait flag is accepted
 * - agent shows send in subcommands
 */

import assert from 'node:assert'
import { $ } from 'zx'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

$.verbose = false

console.log('=== Send Command Tests ===\n')

// Get random port that's definitely not in use (never 6767)
const port = 10000 + Math.floor(Math.random() * 50000)
const paseoHome = await mkdtemp(join(tmpdir(), 'paseo-test-home-'))

try {
  // Test 1: send --help shows options
  {
    console.log('Test 1: send --help shows options')
    const result = await $`npx paseo send --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'send --help should exit 0')
    assert(result.stdout.includes('--no-wait'), 'help should mention --no-wait flag')
    assert(result.stdout.includes('--host'), 'help should mention --host option')
    assert(result.stdout.includes('<id>'), 'help should mention id argument')
    assert(result.stdout.includes('<prompt>'), 'help should mention prompt argument')
    console.log('  help should mention --no-wait flag')
    console.log('  help should mention --host option')
    console.log('  help should mention <id> argument')
    console.log('  help should mention <prompt> argument')
    console.log('✓ send --help shows options\n')
  }

  // Test 2: send requires id argument
  {
    console.log('Test 2: send requires id argument')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo send`.nothrow()
    assert.notStrictEqual(result.exitCode, 0, 'should fail without id')
    const output = result.stdout + result.stderr
    // Commander should complain about missing argument
    const hasMissingArg =
      output.toLowerCase().includes('missing') ||
      output.toLowerCase().includes('required') ||
      output.toLowerCase().includes('argument')
    assert(hasMissingArg, 'error should mention missing argument')
    console.log('✓ send requires id argument\n')
  }

  // Test 3: send requires prompt argument
  {
    console.log('Test 3: send requires prompt argument')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo send abc123`.nothrow()
    assert.notStrictEqual(result.exitCode, 0, 'should fail without prompt')
    const output = result.stdout + result.stderr
    // Commander should complain about missing argument
    const hasMissingArg =
      output.toLowerCase().includes('missing') ||
      output.toLowerCase().includes('required') ||
      output.toLowerCase().includes('argument')
    assert(hasMissingArg, 'error should mention missing argument')
    console.log('✓ send requires prompt argument\n')
  }

  // Test 4: send handles daemon not running
  {
    console.log('Test 4: send handles daemon not running')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo send abc123 "test prompt"`.nothrow()
    // Should fail because daemon not running
    assert.notStrictEqual(result.exitCode, 0, 'should fail when daemon not running')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('daemon') ||
      output.toLowerCase().includes('connect') ||
      output.toLowerCase().includes('cannot')
    assert(hasError, 'error message should mention connection issue')
    console.log('✓ send handles daemon not running\n')
  }

  // Test 5: send --no-wait flag is accepted
  {
    console.log('Test 5: send --no-wait flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo send --no-wait abc123 "test prompt"`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --no-wait flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ send --no-wait flag is accepted\n')
  }

  // Test 6: send --host flag is accepted
  {
    console.log('Test 6: send --host flag is accepted')
    const result =
      await $`PASEO_HOME=${paseoHome} npx paseo send --host localhost:${port} abc123 "test prompt"`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --host flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ send --host flag is accepted\n')
  }

  // Test 7: -q (quiet) flag is accepted with send
  {
    console.log('Test 7: -q (quiet) flag is accepted with send')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo -q send --no-wait abc123 "test prompt"`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept -q flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ -q (quiet) flag is accepted with send\n')
  }

  // Test 8: Combined flags work together
  {
    console.log('Test 8: Combined flags work together')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo -q send --no-wait abc123 "Run the linter"`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept all combined flags')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ Combined flags work together\n')
  }

  // Test 9: paseo --help shows send command
  {
    console.log('Test 9: paseo --help shows send command')
    const result = await $`npx paseo --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'paseo --help should exit 0')
    assert(result.stdout.includes('send'), 'help should mention send command')
    console.log('✓ paseo --help shows send command\n')
  }

  // Test 10: ID prefix syntax is mentioned in help
  {
    console.log('Test 10: send command description mentions ID')
    const result = await $`npx paseo send --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'send --help should exit 0')
    const hasIdMention =
      result.stdout.toLowerCase().includes('id') ||
      result.stdout.toLowerCase().includes('prefix')
    assert(hasIdMention, 'help should mention ID or prefix')
    console.log('✓ send command description mentions ID\n')
  }
} finally {
  // Clean up temp directory
  await rm(paseoHome, { recursive: true, force: true })
}

console.log('=== All send tests passed ===')
