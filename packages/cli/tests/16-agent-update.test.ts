#!/usr/bin/env npx tsx

/**
 * Phase 16: Agent Update Command Tests
 *
 * Tests the agent update command for metadata updates.
 * Since daemon may not be running, we test:
 * - Help and argument parsing
 * - Validation for required update fields
 * - Graceful daemon connection errors
 * - Top-level daemon update alias behavior (`junction update`)
 */

import assert from 'node:assert'
import { $ } from 'zx'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getAvailablePort } from './helpers/network.ts'

$.verbose = false

console.log('=== Agent Update Command Tests ===\n')

// Resolve an available local port so daemon-not-running checks stay deterministic.
const port = await getAvailablePort()
const junctionHome = await mkdtemp(join(tmpdir(), 'junction-test-home-'))

try {
  // Test 1: agent update --help shows options
  {
    console.log('Test 1: agent update --help shows options')
    const result = await $`npx junction agent update --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'agent update --help should exit 0')
    assert(result.stdout.includes('--name'), 'help should mention --name flag')
    assert(result.stdout.includes('--label'), 'help should mention --label flag')
    assert(result.stdout.includes('--host'), 'help should mention --host option')
    assert(result.stdout.includes('<id>'), 'help should mention required id argument')
    console.log('✓ agent update --help shows options\n')
  }

  // Test 2: agent update requires ID argument
  {
    console.log('Test 2: agent update requires ID argument')
    const result =
      await $`JUNCTION_HOST=localhost:${port} JUNCTION_HOME=${junctionHome} npx junction agent update --name "New Name"`.nothrow()
    assert.notStrictEqual(result.exitCode, 0, 'should fail without id')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('missing') ||
      output.toLowerCase().includes('required') ||
      output.toLowerCase().includes('argument') ||
      output.toLowerCase().includes('id')
    assert(hasError, 'error should mention missing argument')
    console.log('✓ agent update requires ID argument\n')
  }

  // Test 3: agent update requires at least one update field
  {
    console.log('Test 3: agent update requires update field')
    const result =
      await $`JUNCTION_HOST=localhost:${port} JUNCTION_HOME=${junctionHome} npx junction agent update abc123`.nothrow()
    assert.notStrictEqual(result.exitCode, 0, 'should fail without --name/--label')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('nothing to update') ||
      output.toLowerCase().includes('name') ||
      output.toLowerCase().includes('label')
    assert(hasError, 'error should mention missing update fields')
    console.log('✓ agent update requires update field\n')
  }

  // Test 4: agent update handles daemon not running
  {
    console.log('Test 4: agent update handles daemon not running')
    const result =
      await $`JUNCTION_HOST=localhost:${port} JUNCTION_HOME=${junctionHome} npx junction agent update abc123 --name "Renamed Agent"`.nothrow()
    assert.notStrictEqual(result.exitCode, 0, 'should fail when daemon not running')
    const output = result.stdout + result.stderr
    const hasError =
      output.toLowerCase().includes('daemon') ||
      output.toLowerCase().includes('connect') ||
      output.toLowerCase().includes('cannot')
    assert(hasError, 'error should mention connection issue')
    console.log('✓ agent update handles daemon not running\n')
  }

  // Test 5: agent update accepts multiple/comma-separated labels
  {
    console.log('Test 5: agent update accepts multi-label syntax')
    const result =
      await $`JUNCTION_HOST=localhost:${port} JUNCTION_HOME=${junctionHome} npx junction agent update abc123 --label ui=true,area=frontend --label priority=high`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept --label flag')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    console.log('✓ agent update accepts multi-label syntax\n')
  }

  // Test 6: agent --help shows update subcommand
  {
    console.log('Test 6: agent --help shows update subcommand')
    const result = await $`npx junction agent --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'agent --help should exit 0')
    assert(result.stdout.includes('update'), 'help should mention update subcommand')
    console.log('✓ agent --help shows update subcommand\n')
  }

  // Test 7: top-level update alias --help shows daemon update options
  {
    console.log('Test 7: top-level update --help shows daemon update options')
    const result = await $`npx junction update --help`.nothrow()
    assert.strictEqual(result.exitCode, 0, 'update --help should exit 0')
    assert(result.stdout.includes('--home'), 'help should mention --home flag')
    assert(result.stdout.includes('--yes'), 'help should mention --yes flag')
    assert(result.stdout.includes('daemon update'), 'help should mention daemon update alias')
    console.log('✓ top-level update --help shows daemon update options\n')
  }

  // Test 8: top-level update alias accepts daemon update flags
  {
    console.log('Test 8: top-level update alias accepts daemon update flags')
    const result =
      await $`JUNCTION_HOME=${junctionHome} npx junction update --home ${junctionHome} --yes --help`.nothrow()
    const output = result.stdout + result.stderr
    assert(!output.includes('unknown option'), 'should accept top-level update flags')
    assert(!output.includes('error: option'), 'should not have option parsing error')
    assert.strictEqual(result.exitCode, 0, 'update alias help with flags should exit 0')
    console.log('✓ top-level update alias accepts daemon update flags\n')
  }
} finally {
  // Clean up temp directory
  await rm(junctionHome, { recursive: true, force: true })
}

console.log('=== All agent update tests passed ===')
