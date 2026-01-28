#!/usr/bin/env npx tsx

/**
 * Phase 4: Agent Run Command Tests
 *
 * Tests the agent run command - creating and running agents with tasks.
 * Since daemon may not be running, we test both:
 * - Help and argument parsing
 * - Graceful error handling when daemon not running
 * - All flags are accepted
 *
 * Tests:
 * - agent run --help shows options
 * - agent run requires prompt argument
 * - agent run handles daemon not running
 * - agent run -d flag is accepted
 * - agent run --name flag is accepted
 * - agent run --provider flag is accepted
 * - agent run --mode flag is accepted
 * - agent run --cwd flag is accepted
 */

import assert from 'node:assert'
import { $ } from 'zx'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

$.verbose = false

console.log('=== Agent Run Command Tests ===\n')

// Get random port that's definitely not in use (never 6767)
const port = 10000 + Math.floor(Math.random() * 50000)
const paseoHome = await mkdtemp(join(tmpdir(), 'paseo-test-home-'))

try {
  // Test 1: agent run --help shows options
  {
    console.log('Test 1: agent run --help shows options')
    const result = await $`npx paseo agent run --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'agent run --help should exit 0')
    assert(result.stdout.includes('-d'), 'help should mention -d flag')
    assert(result.stdout.includes('--detach'), 'help should mention --detach flag')
    assert(result.stdout.includes('--name'), 'help should mention --name option')
    assert(result.stdout.includes('--provider'), 'help should mention --provider option')
    assert(result.stdout.includes('--mode'), 'help should mention --mode option')
    assert(result.stdout.includes('--cwd'), 'help should mention --cwd option')
    assert(result.stdout.includes('--host'), 'help should mention --host option')
    assert(result.stdout.includes('<prompt>'), 'help should mention prompt argument')
    console.log('✓ agent run --help shows options\n')
  }

  // Test 2: agent run requires prompt argument
  {
    console.log('Test 2: agent run requires prompt argument')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent run`.nothrow()
    assert.notStrictEqual(result.exitCode, 0, 'should fail without prompt')
    const output = result.stdout + result.stderr
    // Commander should complain about missing argument
    const hasMissingArg =
      output.toLowerCase().includes('missing') ||
      output.toLowerCase().includes('required') ||
      output.toLowerCase().includes('argument')
    assert(hasMissingArg, 'error should mention missing argument')
    console.log('✓ agent run requires prompt argument\n')
  }

  // Test 3: agent run handles daemon not running
  {
    console.log('Test 3: agent run handles daemon not running')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent run "test prompt"`.nothrow()
    // Should fail because daemon not running
    assert.notStrictEqual(result.exitCode, 0, 'should fail when daemon not running')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('daemon') ||
      output.toLowerCase().includes('connect') ||
      output.toLowerCase().includes('cannot')
    assert(hasError, 'error message should mention connection issue')
    console.log('✓ agent run handles daemon not running\n')
  }

  // Test 4: agent run -d flag is accepted
  {
    console.log('Test 4: agent run -d flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent run -d "test prompt"`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept -d flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ agent run -d flag is accepted\n')
  }

  // Test 5: agent run --name flag is accepted
  {
    console.log('Test 5: agent run --name flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent run --name "test-agent" "test prompt"`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --name flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ agent run --name flag is accepted\n')
  }

  // Test 6: agent run --provider flag is accepted
  {
    console.log('Test 6: agent run --provider flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent run --provider codex "test prompt"`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --provider flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ agent run --provider flag is accepted\n')
  }

  // Test 7: agent run --mode flag is accepted
  {
    console.log('Test 7: agent run --mode flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent run --mode bypass "test prompt"`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --mode flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ agent run --mode flag is accepted\n')
  }

  // Test 8: agent run --cwd flag is accepted
  {
    console.log('Test 8: agent run --cwd flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo agent run --cwd /tmp "test prompt"`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --cwd flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ agent run --cwd flag is accepted\n')
  }

  // Test 9: -q (quiet) flag is accepted with agent run
  {
    console.log('Test 9: -q (quiet) flag is accepted with agent run')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo -q agent run -d "test prompt"`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept -q flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ -q (quiet) flag is accepted with agent run\n')
  }

  // Test 10: Combined flags work together
  {
    console.log('Test 10: Combined flags work together')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo -q agent run -d --name "test-fixer" --provider claude --mode bypass --cwd /tmp "Fix the tests"`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept all combined flags')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ Combined flags work together\n')
  }

  // Test 11: agent shows run in subcommands
  {
    console.log('Test 11: agent --help shows run subcommand')
    const result = await $`npx paseo agent --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'agent --help should exit 0')
    assert(result.stdout.includes('run'), 'help should mention run subcommand')
    console.log('✓ agent --help shows run subcommand\n')
  }
} finally {
  // Clean up temp directory
  await rm(paseoHome, { recursive: true, force: true })
}

console.log('=== All agent run tests passed ===')
