#!/usr/bin/env npx tsx

/**
 * Delete Command Tests
 *
 * Tests the delete command - hard-deleting agents (interrupt if running first).
 * Since daemon may not be running, we test both:
 * - Help and argument parsing
 * - Graceful error handling when daemon not running
 * - All flags are accepted
 */

import assert from 'node:assert'
import { $ } from 'zx'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

$.verbose = false

console.log('=== Delete Command Tests ===\n')

const cliRoot = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(cliRoot, '..', '..', '..')
const port = 10000 + Math.floor(Math.random() * 50000)
const paseoHome = await mkdtemp(join(tmpdir(), 'paseo-delete-test-home-'))

async function runCli(args: string[]) {
  return $`npm --prefix ${repoRoot} run cli -- ${args}`.nothrow()
}

async function runDelete(args: string[]) {
  return $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npm --prefix ${repoRoot} run cli -- delete ${args}`.nothrow()
}

try {
  {
    console.log('Test 1: delete --help shows options')
    const result = await runDelete(['--help'])
    assert.strictEqual(result.exitCode, 0, 'delete --help should exit 0')
    assert(result.stdout.includes('--all'), 'help should mention --all flag')
    assert(result.stdout.includes('--cwd'), 'help should mention --cwd option')
    assert(result.stdout.includes('--host'), 'help should mention --host option')
    assert(result.stdout.includes('[id]'), 'help should mention optional id argument')
    console.log('✓ delete --help shows options\n')
  }

  {
    console.log('Test 2: delete requires ID, --all, or --cwd')
    const result = await runDelete([])
    assert.notStrictEqual(result.exitCode, 0, 'should fail without id, --all, or --cwd')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('missing') ||
      output.toLowerCase().includes('required') ||
      output.toLowerCase().includes('argument') ||
      output.toLowerCase().includes('id')
    assert(hasError, 'error should mention missing argument')
    console.log('✓ delete requires ID, --all, or --cwd\n')
  }

  {
    console.log('Test 3: delete handles daemon not running')
    const result = await runDelete(['abc123'])
    assert.notStrictEqual(result.exitCode, 0, 'should fail when daemon not running')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('daemon') ||
      output.toLowerCase().includes('connect') ||
      output.toLowerCase().includes('cannot')
    assert(hasError, 'error message should mention connection issue')
    console.log('✓ delete handles daemon not running\n')
  }

  {
    console.log('Test 4: delete --all flag is accepted')
    const result = await runDelete(['--all'])
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --all flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ delete --all flag is accepted\n')
  }

  {
    console.log('Test 5: delete --cwd flag is accepted')
    const result = await runDelete(['--cwd', '/tmp'])
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --cwd flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ delete --cwd flag is accepted\n')
  }

  {
    console.log('Test 6: delete with ID and --host flag is accepted')
    const result = await runDelete(['abc123', '--host', `localhost:${port}`])
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --host flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ delete with ID and --host flag is accepted\n')
  }

  {
    console.log('Test 7: paseo --help shows delete command')
    const result = await runCli(['--help'])
    assert.strictEqual(result.exitCode, 0, 'paseo --help should exit 0')
    assert(result.stdout.includes('delete'), 'help should mention delete command')
    console.log('✓ paseo --help shows delete command\n')
  }

  {
    console.log('Test 8: -q (quiet) flag is accepted with delete')
    const result =
      await $`PASEO_HOST=localhost:${port} PASEO_HOME=${paseoHome} npm --prefix ${repoRoot} run cli -- -q delete abc123`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept -q flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ -q (quiet) flag is accepted with delete\n')
  }
} finally {
  await rm(paseoHome, { recursive: true, force: true })
}

console.log('=== All delete tests passed ===')
