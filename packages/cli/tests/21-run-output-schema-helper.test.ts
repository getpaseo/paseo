#!/usr/bin/env npx tsx

import assert from 'node:assert'
import {
  resolveStructuredResponseMessage,
  type StructuredResponseTimelineClient,
} from '../src/commands/agent/run.ts'

type TimelineEntry = {
  item: {
    type: string
    text?: string
  }
}

function createClient(options: {
  entries?: TimelineEntry[]
  throwOnFetch?: boolean
  onFetch?: () => void
}): StructuredResponseTimelineClient {
  return {
    fetchAgentTimeline: async () => {
      options.onFetch?.()
      if (options.throwOnFetch) {
        throw new Error('timeline unavailable')
      }
      return {
        entries: options.entries ?? [],
      } as Awaited<ReturnType<StructuredResponseTimelineClient['fetchAgentTimeline']>>
    },
  }
}

console.log('=== Run Output Schema Helper Tests ===\n')

// Test 1: Direct lastMessage is returned without timeline fetch.
{
  let fetchCount = 0
  const client = createClient({ onFetch: () => fetchCount += 1 })
  const result = await resolveStructuredResponseMessage({
    client,
    agentId: 'agent-1',
    lastMessage: '  {"summary":"ok"}  ',
  })
  assert.strictEqual(result, '{"summary":"ok"}')
  assert.strictEqual(fetchCount, 0, 'should not fetch timeline when lastMessage exists')
  console.log('✓ returns direct lastMessage when present')
}

// Test 2: Falls back to latest assistant message from timeline.
{
  const client = createClient({
    entries: [
      { item: { type: 'user_message', text: 'prompt' } },
      { item: { type: 'assistant_message', text: '' } },
      { item: { type: 'assistant_message', text: ' {"summary":"from timeline"} ' } },
    ],
  })
  const result = await resolveStructuredResponseMessage({
    client,
    agentId: 'agent-2',
    lastMessage: null,
  })
  assert.strictEqual(result, '{"summary":"from timeline"}')
  console.log('✓ falls back to latest assistant timeline entry')
}

// Test 3: Returns null when timeline has no assistant messages.
{
  const client = createClient({
    entries: [
      { item: { type: 'user_message', text: 'prompt' } },
      { item: { type: 'reasoning', text: 'thinking' } },
    ],
  })
  const result = await resolveStructuredResponseMessage({
    client,
    agentId: 'agent-3',
    lastMessage: null,
  })
  assert.strictEqual(result, null)
  console.log('✓ returns null when no assistant messages exist')
}

// Test 4: Returns null if timeline fetch fails.
{
  const client = createClient({ throwOnFetch: true })
  const result = await resolveStructuredResponseMessage({
    client,
    agentId: 'agent-4',
    lastMessage: null,
  })
  assert.strictEqual(result, null)
  console.log('✓ returns null when timeline fetch throws')
}

console.log('\n=== All helper tests passed ===')
