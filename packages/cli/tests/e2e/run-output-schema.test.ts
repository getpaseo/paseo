#!/usr/bin/env npx tsx

import assert from 'node:assert'
import { createE2ETestContext, type TestDaemonContext } from '../helpers/test-daemon.ts'

interface E2EContext extends TestDaemonContext {
  junction: (args: string[], opts?: { timeout?: number; cwd?: string }) => Promise<{
    exitCode: number
    stdout: string
    stderr: string
  }>
}

const schema = JSON.stringify({
  type: 'object',
  properties: {
    summary: { type: 'string' },
  },
  required: ['summary'],
  additionalProperties: false,
})

const impossibleSchema = JSON.stringify({
  type: 'object',
  properties: {
    summary: { type: 'string' },
  },
  required: ['summary'],
  allOf: [
    { properties: { summary: { type: 'string' } } },
    { properties: { summary: { type: 'number' } } },
  ],
})

let ctx: E2EContext

async function setup(): Promise<void> {
  ctx = await createE2ETestContext({ timeout: 180000 })
}

async function cleanup(): Promise<void> {
  if (ctx) {
    await ctx.stop()
  }
}

async function runProviderCase(input: {
  provider: 'claude' | 'codex' | 'opencode'
  mode: string
  model: string
}): Promise<void> {
  const result = await ctx.junction(
    [
      'run',
      '--provider',
      input.provider,
      '--mode',
      input.mode,
      '--model',
      input.model,
      '--output-schema',
      schema,
      `Return valid JSON with a short summary for provider ${input.provider}.`,
    ],
    { timeout: 180000 }
  )

  assert.strictEqual(
    result.exitCode,
    0,
    `expected ${input.provider} run to succeed, got ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  )

  const parsed = JSON.parse(result.stdout.trim()) as { summary?: unknown }
  assert.strictEqual(
    typeof parsed.summary,
    'string',
    `expected ${input.provider} output to contain string summary, got: ${result.stdout}`
  )
  assert(parsed.summary && parsed.summary.length > 0, 'summary must not be empty')
}

async function test_all_providers_return_structured_output(): Promise<void> {
  await runProviderCase({
    provider: 'claude',
    mode: 'bypassPermissions',
    model: 'haiku',
  })
  await runProviderCase({
    provider: 'codex',
    mode: 'full-access',
    model: 'gpt-5.3-codex',
  })
  await runProviderCase({
    provider: 'opencode',
    mode: 'default',
    model: 'opencode/kimi-k2.5-free',
  })
}

async function test_schema_validation_is_enforced(): Promise<void> {
  const result = await ctx.junction(
    [
      'run',
      '--provider',
      'claude',
      '--mode',
      'bypassPermissions',
      '--model',
      'haiku',
      '--output-schema',
      impossibleSchema,
      'Return exactly {"summary":"ok"} and nothing else.',
    ],
    { timeout: 180000 }
  )

  assert.notStrictEqual(result.exitCode, 0, 'expected impossible schema to fail')
  const output = `${result.stdout}\n${result.stderr}`
  assert(
    output.includes('OUTPUT_SCHEMA_FAILED'),
    `expected OUTPUT_SCHEMA_FAILED for impossible schema\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  )
}

async function main(): Promise<void> {
  try {
    await setup()
    await test_all_providers_return_structured_output()
    await test_schema_validation_is_enforced()
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    await cleanup()
  }
}

main()
