#!/usr/bin/env npx tsx

/**
 * Phase 15: Provider Command Tests
 *
 * Tests provider commands for listing providers and models.
 * Provider data is static and doesn't require a running daemon.
 *
 * Tests:
 * - provider --help shows subcommands
 * - provider ls lists all providers
 * - provider ls --json outputs valid JSON
 * - provider ls --quiet outputs provider names only
 * - provider models claude lists claude models
 * - provider models codex lists codex models
 * - provider models opencode lists opencode models
 * - provider models unknown fails with error
 * - provider models --json outputs valid JSON
 */

import assert from 'node:assert'
import { $ } from 'zx'

$.verbose = false

console.log('=== Provider Commands ===\n')

// Test 1: provider --help shows subcommands
{
  console.log('Test 1: provider --help shows subcommands')
  const result = await $`npx paseo provider --help`.nothrow()
  assert.strictEqual(result.exitCode, 0, 'provider --help should exit 0')
  assert(result.stdout.includes('ls'), 'help should mention ls')
  assert(result.stdout.includes('models'), 'help should mention models')
  console.log('✓ provider --help shows subcommands\n')
}

// Test 2: provider ls lists all providers
{
  console.log('Test 2: provider ls lists all providers')
  const result = await $`npx paseo provider ls`.nothrow()
  assert.strictEqual(result.exitCode, 0, 'provider ls should exit 0')
  assert(result.stdout.includes('claude'), 'output should include claude')
  assert(result.stdout.includes('codex'), 'output should include codex')
  assert(result.stdout.includes('opencode'), 'output should include opencode')
  assert(result.stdout.includes('available'), 'output should show available status')
  console.log('✓ provider ls lists all providers\n')
}

// Test 3: provider ls --json outputs valid JSON
{
  console.log('Test 3: provider ls --json outputs valid JSON')
  const result = await $`npx paseo provider ls --json`.nothrow()
  assert.strictEqual(result.exitCode, 0, 'should exit 0')
  const data = JSON.parse(result.stdout.trim())
  assert(Array.isArray(data), 'output should be an array')
  assert.strictEqual(data.length, 3, 'should have 3 providers')
  assert(data.some((p: { provider: string }) => p.provider === 'claude'), 'should include claude')
  assert(data.some((p: { provider: string }) => p.provider === 'codex'), 'should include codex')
  assert(data.some((p: { provider: string }) => p.provider === 'opencode'), 'should include opencode')
  console.log('✓ provider ls --json outputs valid JSON\n')
}

// Test 4: provider ls --quiet outputs provider names only
{
  console.log('Test 4: provider ls --quiet outputs provider names only')
  const result = await $`npx paseo provider ls --quiet`.nothrow()
  assert.strictEqual(result.exitCode, 0, 'should exit 0')
  const lines = result.stdout.trim().split('\n')
  assert.strictEqual(lines.length, 3, 'should have 3 lines')
  assert(lines.includes('claude'), 'should include claude')
  assert(lines.includes('codex'), 'should include codex')
  assert(lines.includes('opencode'), 'should include opencode')
  console.log('✓ provider ls --quiet outputs provider names only\n')
}

// Test 5: provider models claude lists claude models
{
  console.log('Test 5: provider models claude lists claude models')
  const result = await $`npx paseo provider models claude`.nothrow()
  assert.strictEqual(result.exitCode, 0, 'provider models claude should exit 0')
  assert(result.stdout.includes('claude-sonnet-4-20250514'), 'output should include claude-sonnet-4')
  assert(result.stdout.includes('claude-opus-4-20250514'), 'output should include claude-opus-4')
  assert(result.stdout.includes('claude-3-5-haiku-20241022'), 'output should include claude-haiku')
  console.log('✓ provider models claude lists claude models\n')
}

// Test 6: provider models codex lists codex models
{
  console.log('Test 6: provider models codex lists codex models')
  const result = await $`npx paseo provider models codex`.nothrow()
  assert.strictEqual(result.exitCode, 0, 'provider models codex should exit 0')
  assert(result.stdout.includes('o3-mini'), 'output should include o3-mini')
  assert(result.stdout.includes('o4-mini'), 'output should include o4-mini')
  console.log('✓ provider models codex lists codex models\n')
}

// Test 7: provider models opencode lists opencode models
{
  console.log('Test 7: provider models opencode lists opencode models')
  const result = await $`npx paseo provider models opencode`.nothrow()
  assert.strictEqual(result.exitCode, 0, 'provider models opencode should exit 0')
  // opencode supports both claude and codex models
  assert(result.stdout.includes('claude-sonnet-4-20250514'), 'output should include claude models')
  assert(result.stdout.includes('o3-mini'), 'output should include codex models')
  console.log('✓ provider models opencode lists opencode models\n')
}

// Test 8: provider models unknown fails with error
{
  console.log('Test 8: provider models unknown fails with error')
  const result = await $`npx paseo provider models unknown`.nothrow()
  assert.notStrictEqual(result.exitCode, 0, 'should fail for unknown provider')
  const output = result.stdout + result.stderr
  assert(
    output.toLowerCase().includes('unknown') || output.toLowerCase().includes('provider'),
    'error should mention unknown provider'
  )
  console.log('✓ provider models unknown fails with error\n')
}

// Test 9: provider models --json outputs valid JSON
{
  console.log('Test 9: provider models --json outputs valid JSON')
  const result = await $`npx paseo provider models claude --json`.nothrow()
  assert.strictEqual(result.exitCode, 0, 'should exit 0')
  const data = JSON.parse(result.stdout.trim())
  assert(Array.isArray(data), 'output should be an array')
  assert.strictEqual(data.length, 3, 'should have 3 models for claude')
  assert(data.every((m: { model: string; id: string }) => m.model && m.id), 'each model should have name and id')
  console.log('✓ provider models --json outputs valid JSON\n')
}

// Test 10: provider models --quiet outputs model IDs only
{
  console.log('Test 10: provider models --quiet outputs model IDs only')
  const result = await $`npx paseo provider models claude --quiet`.nothrow()
  assert.strictEqual(result.exitCode, 0, 'should exit 0')
  const lines = result.stdout.trim().split('\n')
  assert.strictEqual(lines.length, 3, 'should have 3 lines')
  assert(lines.includes('claude-sonnet-4-20250514'), 'should include claude-sonnet-4')
  assert(lines.includes('claude-opus-4-20250514'), 'should include claude-opus-4')
  assert(lines.includes('claude-3-5-haiku-20241022'), 'should include claude-haiku')
  console.log('✓ provider models --quiet outputs model IDs only\n')
}

console.log('=== All provider tests passed ===')
