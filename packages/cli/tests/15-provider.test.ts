#!/usr/bin/env npx tsx

/**
 * Phase 15: Provider Command Tests
 *
 * Tests provider commands for listing providers and models.
 * Provider ls data is static, while provider models are fetched via daemon integration.
 * This test uses an isolated daemon to avoid coupling to a user's long-running daemon.
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
import { createE2ETestContext } from './helpers/test-daemon.ts'

console.log('=== Provider Commands ===\n')

type ProviderModel = {
  model: string
  id: string
  description?: string
}

let claudeModelIdsFromJson: string[] = []
let claudeModelsFromJson: ProviderModel[] = []

const ctx = await createE2ETestContext({ timeout: 120000 })

async function runProviderModelsJson(
  provider: 'claude' | 'codex' | 'opencode'
): Promise<ProviderModel[]> {
  const transientNeedles = ['transport closed', 'timed out', 'timeout', 'socket', 'econn']

  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await ctx.paseo(['provider', 'models', provider, '--json'])
    if (result.exitCode === 0) {
      return JSON.parse(result.stdout.trim()) as ProviderModel[]
    }

    const combined = `${result.stdout}\n${result.stderr}`
    const normalized = combined.toLowerCase()
    const isTransient = transientNeedles.some((needle) => normalized.includes(needle))

    if (!isTransient || attempt === 3) {
      assert.fail(`provider models ${provider} should exit 0\n${combined}`)
    }

    await new Promise((resolve) => setTimeout(resolve, 250 * attempt))
  }

  assert.fail(`provider models ${provider} exhausted retries`)
}

try {
  // Test 1: provider --help shows subcommands
  {
    console.log('Test 1: provider --help shows subcommands')
    const result = await ctx.paseo(['provider', '--help'])
    assert.strictEqual(result.exitCode, 0, 'provider --help should exit 0')
    assert(result.stdout.includes('ls'), 'help should mention ls')
    assert(result.stdout.includes('models'), 'help should mention models')
    console.log('✓ provider --help shows subcommands\n')
  }

  // Test 2: provider ls lists all providers
  {
    console.log('Test 2: provider ls lists all providers')
    const result = await ctx.paseo(['provider', 'ls'])
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
    const result = await ctx.paseo(['provider', 'ls', '--json'])
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
    const result = await ctx.paseo(['provider', 'ls', '--quiet'])
    assert.strictEqual(result.exitCode, 0, 'should exit 0')
    const lines = result.stdout.trim().split('\n')
    assert.strictEqual(lines.length, 3, 'should have 3 lines')
    assert(lines.includes('claude'), 'should include claude')
    assert(lines.includes('codex'), 'should include codex')
    assert(lines.includes('opencode'), 'should include opencode')
    console.log('✓ provider ls --quiet outputs provider names only\n')
  }

  // Test 5: provider models claude lists canonical model aliases
  {
    console.log('Test 5: provider models claude lists canonical model aliases')
    const data = await runProviderModelsJson('claude')
    assert.strictEqual(data.length, 3, 'should have exactly 3 claude models')
    const byId = new Map(data.map((model) => [model.id, model]))
    const ids = [...byId.keys()].sort()
    assert.deepStrictEqual(ids, ['default', 'haiku', 'opus'], 'claude IDs should be default/opus/haiku')
    assert.strictEqual(byId.get('default')?.model, 'Sonnet 4.5', 'default claude alias should map to Sonnet 4.5')
    assert.strictEqual(byId.get('opus')?.model, 'Opus 4.6', 'opus claude alias should map to Opus 4.6')
    assert.strictEqual(byId.get('haiku')?.model, 'Haiku 4.5', 'haiku claude alias should map to Haiku 4.5')
    assert(
      (byId.get('default')?.description ?? '').includes('Best for everyday tasks'),
      'default claude description should mention everyday tasks'
    )
    assert(
      (byId.get('opus')?.description ?? '').includes('Most capable'),
      'opus claude description should mention most capable'
    )
    assert(
      (byId.get('haiku')?.description ?? '').includes('Fastest'),
      'haiku claude description should mention fastest'
    )
    console.log('✓ provider models claude lists canonical model aliases\n')
  }

  // Test 6: provider models codex includes concrete codex model IDs
  {
    console.log('Test 6: provider models codex includes concrete codex model IDs')
    const data = await runProviderModelsJson('codex')
    assert(data.length >= 6, 'codex model list should include current codex lineup')
    const ids = data.map((m) => m.id)
    assert.strictEqual(new Set(ids).size, ids.length, 'codex model IDs should be unique')
    assert(ids.includes('gpt-5.3-codex'), 'codex output should include gpt-5.3-codex')
    assert(ids.includes('gpt-5.3-codex-spark'), 'codex output should include gpt-5.3-codex-spark')
    assert(ids.includes('gpt-5.1-codex-max'), 'codex output should include gpt-5.1-codex-max')
    assert(ids.includes('gpt-5.1-codex-mini'), 'codex output should include gpt-5.1-codex-mini')
    console.log('✓ provider models codex includes concrete codex model IDs\n')
  }

  // Test 7: provider models opencode returns namespaced model IDs
  {
    console.log('Test 7: provider models opencode returns namespaced model IDs')
    const data = await runProviderModelsJson('opencode')
    assert(data.length >= 3, 'opencode model list should not be empty')
    const ids = data.map((m) => m.id)
    assert(data.every((m) => m.id.includes('/')), 'opencode model IDs should be provider-namespaced')
    assert(ids.includes('opencode/gpt-5-nano'), 'opencode output should include opencode/gpt-5-nano')
    assert(ids.includes('openai/o3-mini'), 'opencode output should include openai/o3-mini')
    assert(
      ids.includes('openai/gpt-5.3-codex-spark'),
      'opencode output should include openai/gpt-5.3-codex-spark'
    )
    console.log('✓ provider models opencode returns namespaced model IDs\n')
  }

  // Test 8: provider models unknown fails with error
  {
    console.log('Test 8: provider models unknown fails with error')
    const result = await ctx.paseo(['provider', 'models', 'unknown'])
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
    const data = await runProviderModelsJson('claude')
    assert(Array.isArray(data), 'output should be an array')
    assert.strictEqual(data.length, 3, 'should have exactly 3 models for claude')
    assert(data.every((m) => m.model && m.id), 'each model should have name and id')
    const byId = new Map(data.map((model) => [model.id, model]))
    const ids = [...byId.keys()].sort()
    assert.deepStrictEqual(ids, ['default', 'haiku', 'opus'], 'claude JSON IDs should be deterministic')
    assert.strictEqual(byId.get('default')?.model, 'Sonnet 4.5', 'default claude alias should map to Sonnet 4.5')
    assert.strictEqual(byId.get('opus')?.model, 'Opus 4.6', 'opus claude alias should map to Opus 4.6')
    assert.strictEqual(byId.get('haiku')?.model, 'Haiku 4.5', 'haiku claude alias should map to Haiku 4.5')
    claudeModelIdsFromJson = data.map((m) => m.id)
    claudeModelsFromJson = data
    console.log('✓ provider models --json outputs valid JSON\n')
  }

  // Test 10: provider models --quiet outputs model IDs only
  {
    console.log('Test 10: provider models --quiet outputs model IDs only')
    assert(claudeModelIdsFromJson.length > 0, 'claude model IDs should be captured from --json output')
    const result = await ctx.paseo(['provider', 'models', 'claude', '--quiet'])
    assert.strictEqual(result.exitCode, 0, 'should exit 0')
    const lines = result.stdout.trim().split('\n').filter(Boolean)
    assert.strictEqual(lines.length, 3, 'should have 3 lines')
    assert.deepStrictEqual(
      [...lines].sort(),
      [...claudeModelIdsFromJson].sort(),
      '--quiet should print the same model IDs returned by --json'
    )
    assert.deepStrictEqual(
      [...lines].sort(),
      ['default', 'haiku', 'opus'],
      '--quiet should print canonical claude IDs'
    )
    assert(
      claudeModelsFromJson.some((m) => m.id === 'default'),
      'captured --json output should still include default claude model id'
    )
    console.log('✓ provider models --quiet outputs model IDs only\n')
  }
} finally {
  await ctx.stop()
}

console.log('=== All provider tests passed ===')
