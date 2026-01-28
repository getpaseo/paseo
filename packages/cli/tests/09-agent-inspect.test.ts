#!/usr/bin/env npx tsx

/**
 * Phase 9: Agent Inspect Command Tests
 *
 * Tests the agent inspect command - showing detailed agent information.
 * Since daemon may not be running, we test both:
 * - Help and argument parsing
 * - Graceful error handling when daemon not running
 * - All flags are accepted
 *
 * Tests:
 * - agent inspect --help shows options
 * - agent inspect requires id argument
 * - agent inspect handles daemon not running
 * - agent inspect --host flag is accepted
 * - agent shows inspect in subcommands
 */

import assert from 'node:assert'
import { $ } from 'zx'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

$.verbose = false

console.log('=== Agent Inspect Command Tests ===\n')

// Get random port that's definitely not in use (never 6767)
const port = 10000 + Math.floor(Math.random() * 50000)
const paseoHome = await mkdtemp(join(tmpdir(), 'paseo-test-home-'))

try {
  // Test 1: agent inspect --help shows options
  {
    console.log('Test 1: agent inspect --help shows options')
    const result = await $`npx paseo agent inspect --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'agent inspect --help should exit 0')
    assert(result.stdout.includes('--host'), 'help should mention --host option')
    assert(result.stdout.includes('<id>'), 'help should mention id argument')
    console.log('  help should mention --host option')
    console.log('  help should mention <id> argument')
    console.log('inspect --help shows options\n')
  }

  // Test 2: agent inspect requires id argument
  {
    console.log('Test 2: agent inspect requires id argument')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent inspect`.nothrow()
    assert.notStrictEqual(result.exitCode, 0, 'should fail without id')
    const output = result.stdout + result.stderr
    // Commander should complain about missing argument
    const hasMissingArg =
      output.toLowerCase().includes('missing') ||
      output.toLowerCase().includes('required') ||
      output.toLowerCase().includes('argument')
    assert(hasMissingArg, 'error should mention missing argument')
    console.log('agent inspect requires id argument\n')
  }

  // Test 3: agent inspect handles daemon not running
  {
    console.log('Test 3: agent inspect handles daemon not running')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent inspect abc123`.nothrow()
    // Should fail because daemon not running
    assert.notStrictEqual(result.exitCode, 0, 'should fail when daemon not running')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('daemon') ||
      output.toLowerCase().includes('connect') ||
      output.toLowerCase().includes('cannot')
    assert(hasError, 'error message should mention connection issue')
    console.log('agent inspect handles daemon not running\n')
  }

  // Test 4: agent inspect --host flag is accepted
  {
    console.log('Test 4: agent inspect --host flag is accepted')
    const result =
      await $`PASEO_HOME=${paseoHome} npx paseo agent inspect --host localhost:${port} abc123`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --host flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('agent inspect --host flag is accepted\n')
  }

  // Test 5: -q (quiet) flag is accepted with agent inspect
  {
    console.log('Test 5: -q (quiet) flag is accepted with agent inspect')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo -q agent inspect abc123`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept -q flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('-q (quiet) flag is accepted with agent inspect\n')
  }

  // Test 6: --format json flag is accepted with agent inspect
  {
    console.log('Test 6: --format json flag is accepted with agent inspect')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo --format json agent inspect abc123`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --format json flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('--format json flag is accepted with agent inspect\n')
  }

  // Test 7: --format yaml flag is accepted with agent inspect
  {
    console.log('Test 7: --format yaml flag is accepted with agent inspect')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo --format yaml agent inspect abc123`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --format yaml flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('--format yaml flag is accepted with agent inspect\n')
  }

  // Test 8: agent --help shows inspect subcommand
  {
    console.log('Test 8: agent --help shows inspect subcommand')
    const result = await $`npx paseo agent --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'agent --help should exit 0')
    assert(result.stdout.includes('inspect'), 'help should mention inspect subcommand')
    console.log('agent --help shows inspect subcommand\n')
  }

  // Test 9: inspect command description is helpful
  {
    console.log('Test 9: inspect command description is helpful')
    const result = await $`npx paseo agent inspect --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'agent inspect --help should exit 0')
    const hasDescription =
      result.stdout.toLowerCase().includes('detail') ||
      result.stdout.toLowerCase().includes('information') ||
      result.stdout.toLowerCase().includes('show')
    assert(hasDescription, 'help should describe what inspect does')
    console.log('inspect command description is helpful\n')
  }

  // Test 10: ID prefix syntax is mentioned in help
  {
    console.log('Test 10: inspect command mentions ID')
    const result = await $`npx paseo agent inspect --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'agent inspect --help should exit 0')
    const hasIdMention =
      result.stdout.toLowerCase().includes('id') ||
      result.stdout.toLowerCase().includes('prefix')
    assert(hasIdMention, 'help should mention ID or prefix')
    console.log('inspect command mentions ID\n')
  }
} finally {
  // Clean up temp directory
  await rm(paseoHome, { recursive: true, force: true })
}

console.log('=== All agent inspect tests passed ===')
