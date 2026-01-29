#!/usr/bin/env npx tsx

/**
 * Phase 4: Run Command Tests
 *
 * Tests the run command - creating and running agents with tasks (top-level command).
 * Since daemon may not be running, we test both:
 * - Help and argument parsing
 * - Graceful error handling when daemon not running
 * - All flags are accepted
 *
 * Tests:
 * - run --help shows options
 * - run requires prompt argument
 * - run handles daemon not running
 * - run -d flag is accepted
 * - run --name flag is accepted
 * - run --provider flag is accepted
 * - run --mode flag is accepted
 * - run --cwd flag is accepted
 */

import assert from 'node:assert'
import { $ } from 'zx'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

$.verbose = false

console.log('=== Run Command Tests ===\n')

// Get random port that's definitely not in use (never 6767)
const port = 10000 + Math.floor(Math.random() * 50000)
const paseoHome = await mkdtemp(join(tmpdir(), 'paseo-test-home-'))

try {
  // Test 1: run --help shows options
  {
    console.log('Test 1: run --help shows options')
    const result = await $`npx paseo run --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'run --help should exit 0')
    assert(result.stdout.includes('-d'), 'help should mention -d flag')
    assert(result.stdout.includes('--detach'), 'help should mention --detach flag')
    assert(result.stdout.includes('--name'), 'help should mention --name option')
    assert(result.stdout.includes('--provider'), 'help should mention --provider option')
    assert(result.stdout.includes('--mode'), 'help should mention --mode option')
    assert(result.stdout.includes('--cwd'), 'help should mention --cwd option')
    assert(result.stdout.includes('--host'), 'help should mention --host option')
    assert(result.stdout.includes('<prompt>'), 'help should mention prompt argument')
    console.log('✓ run --help shows options\n')
  }

  // Test 2: run requires prompt argument
  {
    console.log('Test 2: run requires prompt argument')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo run`.nothrow()
    assert.notStrictEqual(result.exitCode, 0, 'should fail without prompt')
    const output = result.stdout + result.stderr
    // Commander should complain about missing argument
    const hasMissingArg =
      output.toLowerCase().includes('missing') ||
      output.toLowerCase().includes('required') ||
      output.toLowerCase().includes('argument')
    assert(hasMissingArg, 'error should mention missing argument')
    console.log('✓ run requires prompt argument\n')
  }

  // Test 3: run handles daemon not running
  {
    console.log('Test 3: run handles daemon not running')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo run "test prompt"`.nothrow()
    // Should fail because daemon not running
    assert.notStrictEqual(result.exitCode, 0, 'should fail when daemon not running')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('daemon') ||
      output.toLowerCase().includes('connect') ||
      output.toLowerCase().includes('cannot')
    assert(hasError, 'error message should mention connection issue')
    console.log('✓ run handles daemon not running\n')
  }

  // Test 4: run -d flag is accepted
  {
    console.log('Test 4: run -d flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo run -d "test prompt"`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept -d flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ run -d flag is accepted\n')
  }

  // Test 5: run --name flag is accepted
  {
    console.log('Test 5: run --name flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo run --name "test-agent" "test prompt"`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --name flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ run --name flag is accepted\n')
  }

  // Test 6: run --provider flag is accepted
  {
    console.log('Test 6: run --provider flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo run --provider codex "test prompt"`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --provider flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ run --provider flag is accepted\n')
  }

  // Test 7: run --mode flag is accepted
  {
    console.log('Test 7: run --mode flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo run --mode bypass "test prompt"`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --mode flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ run --mode flag is accepted\n')
  }

  // Test 8: run --cwd flag is accepted
  {
    console.log('Test 8: run --cwd flag is accepted')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo run --cwd /tmp "test prompt"`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --cwd flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ run --cwd flag is accepted\n')
  }

  // Test 9: -q (quiet) flag is accepted with run
  {
    console.log('Test 9: -q (quiet) flag is accepted with run')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo -q run -d "test prompt"`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept -q flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ -q (quiet) flag is accepted with run\n')
  }

  // Test 10: Combined flags work together
  {
    console.log('Test 10: Combined flags work together')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npx paseo -q run -d --name "test-fixer" --provider claude --mode bypass --cwd /tmp "Fix the tests"`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept all combined flags')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ Combined flags work together\n')
  }

  // Test 11: paseo --help shows run command
  {
    console.log('Test 11: paseo --help shows run command')
    const result = await $`npx paseo --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'paseo --help should exit 0')
    assert(result.stdout.includes('run'), 'help should mention run command')
    console.log('✓ paseo --help shows run command\n')
  }
} finally {
  // Clean up temp directory
  await rm(paseoHome, { recursive: true, force: true })
}

console.log('=== All run tests passed ===')
