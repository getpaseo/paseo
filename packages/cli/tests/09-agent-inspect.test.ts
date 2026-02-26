#!/usr/bin/env npx tsx

/**
 * Phase 9: Inspect Command Tests
 *
 * Tests the inspect command - showing detailed agent information (top-level command).
 * Since daemon may not be running, we test both:
 * - Help and argument parsing
 * - Graceful error handling when daemon not running
 * - All flags are accepted
 *
 * Tests:
 * - inspect --help shows options
 * - inspect requires id argument
 * - inspect handles daemon not running
 * - inspect --host flag is accepted
 * - agent shows inspect in subcommands
 */

import assert from 'node:assert'
import { $ } from 'zx'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

$.verbose = false

console.log('=== Inspect Command Tests ===\n')

// Get random port that's definitely not in use (never 6767)
const port = 10000 + Math.floor(Math.random() * 50000)
const junctionHome = await mkdtemp(join(tmpdir(), 'junction-test-home-'))

try {
  // Test 1: inspect --help shows options
  {
    console.log('Test 1: inspect --help shows options')
    const result = await $`npx junction inspect --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'inspect --help should exit 0')
    assert(result.stdout.includes('--host'), 'help should mention --host option')
    assert(result.stdout.includes('<id>'), 'help should mention id argument')
    console.log('  help should mention --host option')
    console.log('  help should mention <id> argument')
    console.log('inspect --help shows options\n')
  }

  // Test 2: inspect requires id argument
  {
    console.log('Test 2: inspect requires id argument')
    const result =
      await $`JUNCTION_HOST=localhost:${port} JUNCTION_HOME=${junctionHome} npx junction inspect`.nothrow()
    assert.notStrictEqual(result.exitCode, 0, 'should fail without id')
    const output = result.stdout + result.stderr
    // Commander should complain about missing argument
    const hasMissingArg =
      output.toLowerCase().includes('missing') ||
      output.toLowerCase().includes('required') ||
      output.toLowerCase().includes('argument')
    assert(hasMissingArg, 'error should mention missing argument')
    console.log('inspect requires id argument\n')
  }

  // Test 3: inspect handles daemon not running
  {
    console.log('Test 3: inspect handles daemon not running')
    const result =
      await $`JUNCTION_HOST=localhost:${port} JUNCTION_HOME=${junctionHome} npx junction inspect abc123`.nothrow()
    // Should fail because daemon not running
    assert.notStrictEqual(result.exitCode, 0, 'should fail when daemon not running')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('daemon') ||
      output.toLowerCase().includes('connect') ||
      output.toLowerCase().includes('cannot')
    assert(hasError, 'error message should mention connection issue')
    console.log('inspect handles daemon not running\n')
  }

  // Test 4: inspect --host flag is accepted
  {
    console.log('Test 4: inspect --host flag is accepted')
    const result =
      await $`JUNCTION_HOME=${junctionHome} npx junction inspect --host localhost:${port} abc123`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --host flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('inspect --host flag is accepted\n')
  }

  // Test 5: -q (quiet) flag is accepted with inspect
  {
    console.log('Test 5: -q (quiet) flag is accepted with inspect')
    const result =
      await $`JUNCTION_HOST=localhost:${port} JUNCTION_HOME=${junctionHome} npx junction -q inspect abc123`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept -q flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('-q (quiet) flag is accepted with inspect\n')
  }

  // Test 6: --json flag is accepted with inspect
  {
    console.log('Test 6: --json flag is accepted with inspect')
    const result =
      await $`JUNCTION_HOST=localhost:${port} JUNCTION_HOME=${junctionHome} npx junction inspect abc123 --json`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --json flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('--json flag is accepted with inspect\n')
  }

  // Test 7: --format yaml flag is accepted with inspect
  {
    console.log('Test 7: --format yaml flag is accepted with inspect')
    const result =
      await $`JUNCTION_HOST=localhost:${port} JUNCTION_HOME=${junctionHome} npx junction --format yaml inspect abc123`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --format yaml flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('--format yaml flag is accepted with inspect\n')
  }

  // Test 8: junction --help shows inspect command
  {
    console.log('Test 8: junction --help shows inspect command')
    const result = await $`npx junction --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'junction --help should exit 0')
    assert(result.stdout.includes('inspect'), 'help should mention inspect command')
    console.log('junction --help shows inspect command\n')
  }

  // Test 9: inspect command description is helpful
  {
    console.log('Test 9: inspect command description is helpful')
    const result = await $`npx junction inspect --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'inspect --help should exit 0')
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
    const result = await $`npx junction inspect --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'inspect --help should exit 0')
    const hasIdMention =
      result.stdout.toLowerCase().includes('id') ||
      result.stdout.toLowerCase().includes('prefix')
    assert(hasIdMention, 'help should mention ID or prefix')
    console.log('inspect command mentions ID\n')
  }
} finally {
  // Clean up temp directory
  await rm(junctionHome, { recursive: true, force: true })
}

console.log('=== All inspect tests passed ===')
