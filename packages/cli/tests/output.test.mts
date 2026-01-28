#!/usr/bin/env npx tsx
/**
 * Tests for the output abstraction layer.
 *
 * Verifies that renderers correctly format structured data.
 */

import assert from 'node:assert'
import {
  render,
  renderTable,
  renderJson,
  renderYaml,
  renderQuiet,
  renderError,
  toCommandError,
  createOutputOptions,
  type ListResult,
  type SingleResult,
  type OutputSchema,
  type CommandError,
} from '../src/output/index.js'

// Test data types
interface Agent {
  id: string
  title: string
  status: 'running' | 'idle' | 'error'
  provider: string
}

// Schema for agents
const agentSchema: OutputSchema<Agent> = {
  idField: 'id',
  columns: [
    { header: 'ID', field: 'id', width: 8 },
    { header: 'TITLE', field: 'title', width: 20 },
    {
      header: 'STATUS',
      field: 'status',
      color: (value) => {
        switch (value) {
          case 'running':
            return 'green'
          case 'idle':
            return 'dim'
          case 'error':
            return 'red'
          default:
            return undefined
        }
      },
    },
    { header: 'PROVIDER', field: 'provider' },
  ],
}

// Test data
const testAgents: Agent[] = [
  { id: 'abc123', title: 'Feature Implementation', status: 'running', provider: 'claude' },
  { id: 'def456', title: 'Bug Fix', status: 'idle', provider: 'codex' },
  { id: 'ghi789', title: 'Failed Task', status: 'error', provider: 'claude' },
]

const listResult: ListResult<Agent> = {
  type: 'list',
  data: testAgents,
  schema: agentSchema,
}

const singleResult: SingleResult<Agent> = {
  type: 'single',
  data: testAgents[0],
  schema: agentSchema,
}

// Test utilities
let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`✓ ${name}`)
    passed++
  } catch (error) {
    console.error(`✗ ${name}`)
    console.error(`  ${error instanceof Error ? error.message : error}`)
    failed++
  }
}

// Table renderer tests
console.log('\n=== Table Renderer ===\n')

test('renderTable formats list data with headers', () => {
  const output = renderTable(listResult, createOutputOptions({ noColor: true }))
  assert.ok(output.includes('ID'), 'Should include ID header')
  assert.ok(output.includes('TITLE'), 'Should include TITLE header')
  assert.ok(output.includes('STATUS'), 'Should include STATUS header')
  assert.ok(output.includes('abc123'), 'Should include first agent ID')
  assert.ok(output.includes('Feature Implementation'), 'Should include first agent title')
})

test('renderTable omits headers when noHeaders is true', () => {
  const output = renderTable(listResult, createOutputOptions({ noHeaders: true, noColor: true }))
  assert.ok(!output.includes('ID  '), 'Should not include header row')
  assert.ok(output.includes('abc123'), 'Should still include data')
})

test('renderTable handles empty data', () => {
  const emptyResult: ListResult<Agent> = {
    type: 'list',
    data: [],
    schema: agentSchema,
  }
  const output = renderTable(emptyResult, createOutputOptions())
  assert.strictEqual(output, '', 'Should return empty string for empty data')
})

test('renderTable handles single result', () => {
  const output = renderTable(singleResult, createOutputOptions({ noColor: true }))
  assert.ok(output.includes('abc123'), 'Should include agent ID')
  assert.ok(output.includes('Feature Implementation'), 'Should include agent title')
})

// JSON renderer tests
console.log('\n=== JSON Renderer ===\n')

test('renderJson outputs valid JSON for list', () => {
  const output = renderJson(listResult, createOutputOptions())
  const parsed = JSON.parse(output)
  assert.ok(Array.isArray(parsed), 'Should be an array')
  assert.strictEqual(parsed.length, 3, 'Should have 3 items')
  assert.strictEqual(parsed[0].id, 'abc123', 'Should include correct data')
})

test('renderJson outputs valid JSON for single item', () => {
  const output = renderJson(singleResult, createOutputOptions())
  const parsed = JSON.parse(output)
  assert.strictEqual(parsed.id, 'abc123', 'Should include correct data')
  assert.strictEqual(parsed.title, 'Feature Implementation', 'Should include correct title')
})

test('renderJson uses custom serializer when provided', () => {
  const customSchema: OutputSchema<Agent> = {
    ...agentSchema,
    serialize: (agent) => ({ agentId: agent.id, name: agent.title }),
  }
  const customResult: SingleResult<Agent> = {
    type: 'single',
    data: testAgents[0],
    schema: customSchema,
  }
  const output = renderJson(customResult, createOutputOptions())
  const parsed = JSON.parse(output)
  assert.ok('agentId' in parsed, 'Should use custom serialization')
  assert.ok('name' in parsed, 'Should use custom field names')
})

// YAML renderer tests
console.log('\n=== YAML Renderer ===\n')

test('renderYaml outputs valid YAML for list', () => {
  const output = renderYaml(listResult, createOutputOptions())
  assert.ok(output.includes('- id: abc123'), 'Should format as YAML list')
  assert.ok(output.includes('title: Feature Implementation'), 'Should include title')
})

test('renderYaml outputs valid YAML for single item', () => {
  const output = renderYaml(singleResult, createOutputOptions())
  assert.ok(output.includes('id: abc123'), 'Should include ID')
  assert.ok(!output.startsWith('-'), 'Should not be a list')
})

// Quiet renderer tests
console.log('\n=== Quiet Renderer ===\n')

test('renderQuiet outputs only IDs for list', () => {
  const output = renderQuiet(listResult, createOutputOptions())
  const lines = output.split('\n')
  assert.strictEqual(lines.length, 3, 'Should have 3 lines')
  assert.strictEqual(lines[0], 'abc123', 'First line should be first ID')
  assert.strictEqual(lines[1], 'def456', 'Second line should be second ID')
})

test('renderQuiet outputs only ID for single item', () => {
  const output = renderQuiet(singleResult, createOutputOptions())
  assert.strictEqual(output, 'abc123', 'Should output only the ID')
})

test('renderQuiet supports function idField', () => {
  const customSchema: OutputSchema<Agent> = {
    ...agentSchema,
    idField: (agent) => `${agent.provider}/${agent.id}`,
  }
  const customResult: SingleResult<Agent> = {
    type: 'single',
    data: testAgents[0],
    schema: customSchema,
  }
  const output = renderQuiet(customResult, createOutputOptions())
  assert.strictEqual(output, 'claude/abc123', 'Should use function to extract ID')
})

// Main render dispatcher tests
console.log('\n=== Render Dispatcher ===\n')

test('render uses table format by default', () => {
  const output = render(listResult, { noColor: true })
  assert.ok(output.includes('ID'), 'Should use table format with headers')
})

test('render uses json format when specified', () => {
  const output = render(listResult, { format: 'json' })
  const parsed = JSON.parse(output)
  assert.ok(Array.isArray(parsed), 'Should be valid JSON array')
})

test('render uses yaml format when specified', () => {
  const output = render(listResult, { format: 'yaml' })
  assert.ok(output.includes('- id:'), 'Should be valid YAML')
})

test('render uses quiet mode when quiet is true', () => {
  const output = render(listResult, { quiet: true })
  assert.strictEqual(output, 'abc123\ndef456\nghi789', 'Should output only IDs')
})

test('quiet mode takes precedence over format', () => {
  const output = render(listResult, { format: 'json', quiet: true })
  assert.strictEqual(output, 'abc123\ndef456\nghi789', 'Quiet should override format')
})

// Error rendering tests
console.log('\n=== Error Rendering ===\n')

test('renderError formats error for table format', () => {
  const error: CommandError = { code: 'NOT_FOUND', message: 'Agent not found' }
  const output = renderError(error, { noColor: true })
  assert.ok(output.includes('Error:'), 'Should include Error prefix')
  assert.ok(output.includes('Agent not found'), 'Should include message')
})

test('renderError formats error as JSON', () => {
  const error: CommandError = { code: 'NOT_FOUND', message: 'Agent not found' }
  const output = renderError(error, { format: 'json' })
  const parsed = JSON.parse(output)
  assert.ok('error' in parsed, 'Should have error property')
  assert.strictEqual(parsed.error.code, 'NOT_FOUND', 'Should include error code')
})

test('renderError formats error as YAML', () => {
  const error: CommandError = { code: 'NOT_FOUND', message: 'Agent not found' }
  const output = renderError(error, { format: 'yaml' })
  assert.ok(output.includes('error:'), 'Should have error key')
  assert.ok(output.includes('code: NOT_FOUND'), 'Should include error code')
})

test('toCommandError converts Error to CommandError', () => {
  const error = new Error('Something went wrong')
  const commandError = toCommandError(error)
  assert.strictEqual(commandError.code, 'UNKNOWN_ERROR', 'Should use UNKNOWN_ERROR code')
  assert.strictEqual(commandError.message, 'Something went wrong', 'Should preserve message')
})

test('toCommandError passes through CommandError', () => {
  const error: CommandError = { code: 'CUSTOM', message: 'Custom error' }
  const commandError = toCommandError(error)
  assert.strictEqual(commandError.code, 'CUSTOM', 'Should preserve code')
  assert.strictEqual(commandError.message, 'Custom error', 'Should preserve message')
})

// Summary
console.log('\n=== Summary ===\n')
console.log(`Passed: ${passed}`)
console.log(`Failed: ${failed}`)

process.exit(failed > 0 ? 1 : 0)
