#!/usr/bin/env npx tsx

/**
 * Phase 5: Agent Send Command Tests
 *
 * Tests the agent send command - sending messages to existing agents.
 * Since daemon may not be running, we test both:
 * - Help and argument parsing
 * - Graceful error handling when daemon not running
 * - All flags are accepted
 *
 * Tests:
 * - agent send --help shows options
 * - agent send requires id and prompt arguments
 * - agent send handles daemon not running
 * - agent send --no-wait flag is accepted
 * - agent shows send in subcommands
 */

import assert from 'node:assert'
import { $ } from 'zx'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

$.verbose = false

console.log('=== Agent Send Command Tests ===\n')

// Get random port that's definitely not in use (never 6767)
const port = 10000 + Math.floor(Math.random() * 50000)
const paseoHome = await mkdtemp(join(tmpdir(), 'paseo-test-home-'))

try {
  // Test 1: agent send --help shows options
  {
    console.log('Test 1: agent send --help shows options')
    const result = await $`npx paseo agent send --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'agent send --help should exit 0')
    assert(result.stdout.includes('--no-wait'), 'help should mention --no-wait flag')
    assert(result.stdout.includes('--host'), 'help should mention --host option')
    assert(result.stdout.includes('<id>'), 'help should mention id argument')
    assert(result.stdout.includes('<prompt>'), 'help should mention prompt argument')
    console.log('  help should mention --no-wait flag')
    console.log('  help should mention --host option')
    console.log('  help should mention <id> argument')
    console.log('  help should mention <prompt> argument')
    console.log('✓ agent send --help shows options\n')
  }

  // Test 2: agent send requires id argument
  {
    console.log('Test 2: agent send requires id argument')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent send`.nothrow()
    assert.notStrictEqual(result.exitCode, 0, 'should fail without id')
    const output = result.stdout + result.stderr
    // Commander should complain about missing argument
    const hasMissingArg =
      output.toLowerCase().includes('missing') ||
      output.toLowerCase().includes('required') ||
      output.toLowerCase().includes('argument')
    assert(hasMissingArg, 'error should mention missing argument')
    console.log('✓ agent send requires id argument\n')
  }

  // Test 3: agent send requires prompt argument
  {
    console.log('Test 3: agent send requires prompt argument')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent send abc123`.nothrow()
    assert.notStrictEqual(result.exitCode, 0, 'should fail without prompt')
    const output = result.stdout + result.stderr
    // Commander should complain about missing argument
    const hasMissingArg =
      output.toLowerCase().includes('missing') ||
      output.toLowerCase().includes('required') ||
      output.toLowerCase().includes('argument')
    assert(hasMissingArg, 'error should mention missing argument')
    console.log('✓ agent send requires prompt argument\n')
  }

  // Test 4: agent send handles daemon not running
  {
    console.log('Test 4: agent send handles daemon not running')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent send abc123 "test prompt"`.nothrow()
    // Should fail because daemon not running
    assert.notStrictEqual(result.exitCode, 0, 'should fail when daemon not running')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('daemon') ||
      output.toLowerCase().includes('connect') ||
      output.toLowerCase().includes('cannot')
    assert(hasError, 'error message should mention connection issue')
    console.log('✓ agent send handles daemon not running\n')
  }

  // Test 5: agent send --no-wait flag is accepted
  {
    console.log('Test 5: agent send --no-wait flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent send --no-wait abc123 "test prompt"`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --no-wait flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ agent send --no-wait flag is accepted\n')
  }

  // Test 6: agent send --host flag is accepted
  {
    console.log('Test 6: agent send --host flag is accepted')
    const result =
      await $`PASEO_HOME=${paseoHome} npx paseo agent send --host localhost:${port} abc123 "test prompt"`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --host flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ agent send --host flag is accepted\n')
  }

  // Test 7: -q (quiet) flag is accepted with agent send
  {
    console.log('Test 7: -q (quiet) flag is accepted with agent send')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo -q agent send --no-wait abc123 "test prompt"`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept -q flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ -q (quiet) flag is accepted with agent send\n')
  }

  // Test 8: Combined flags work together
  {
    console.log('Test 8: Combined flags work together')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo -q agent send --no-wait abc123 "Run the linter"`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept all combined flags')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ Combined flags work together\n')
  }

  // Test 9: agent --help shows send subcommand
  {
    console.log('Test 9: agent --help shows send subcommand')
    const result = await $`npx paseo agent --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'agent --help should exit 0')
    assert(result.stdout.includes('send'), 'help should mention send subcommand')
    console.log('✓ agent --help shows send subcommand\n')
  }

  // Test 10: ID prefix syntax is mentioned in help
  {
    console.log('Test 10: send command description mentions ID')
    const result = await $`npx paseo agent send --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'agent send --help should exit 0')
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

console.log('=== All agent send tests passed ===')
