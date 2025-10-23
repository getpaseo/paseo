/**
 * Test script to verify idempotent stream reduction
 *
 * This tests that applying the same session updates multiple times
 * or in different orders produces identical results.
 */

import { reduceStreamUpdate, hydrateStreamState, type StreamItem } from './packages/app/src/types/stream';
import type { SessionNotification } from '@agentclientprotocol/sdk';

// Helper to create enriched notifications with messageId
function createAgentMessageChunk(text: string, messageId: string): any {
  return {
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { text },
      messageId,
    },
  };
}

function createAgentThoughtChunk(text: string, messageId: string): any {
  return {
    update: {
      sessionUpdate: 'agent_thought_chunk',
      content: { text },
      messageId,
    },
  };
}

function createUserMessageChunk(text: string, messageId: string): any {
  return {
    update: {
      sessionUpdate: 'user_message_chunk',
      content: { text },
      messageId,
    },
  };
}

function createToolCall(toolCallId: string, title: string): any {
  return {
    update: {
      sessionUpdate: 'tool_call',
      toolCallId,
      title,
      status: 'pending',
    },
  };
}

// Test 1: Same updates applied twice should be idempotent
function testIdempotentReduction() {
  console.log('\n=== Test 1: Idempotent Reduction ===');

  const timestamp1 = new Date('2025-01-01T10:00:00Z');
  const timestamp2 = new Date('2025-01-01T10:00:01Z');
  const timestamp3 = new Date('2025-01-01T10:00:02Z');

  // Create a sequence of updates
  const updates = [
    { notification: createUserMessageChunk('Hello', 'user-msg-1'), timestamp: timestamp1 },
    { notification: createAgentMessageChunk('Hello! ', 'asst-msg-1'), timestamp: timestamp2 },
    { notification: createAgentMessageChunk('How can I ', 'asst-msg-1'), timestamp: timestamp2 },
    { notification: createAgentMessageChunk('help you?', 'asst-msg-1'), timestamp: timestamp2 },
    { notification: createAgentThoughtChunk('Thinking...', 'thought-1'), timestamp: timestamp3 },
  ];

  // Apply updates once
  const state1 = hydrateStreamState(updates);

  // Apply same updates again from scratch
  const state2 = hydrateStreamState(updates);

  // Apply updates twice (should still be same)
  const state3 = updates.reduce(
    (state, { notification, timestamp }) => {
      const s1 = reduceStreamUpdate(state, notification, timestamp);
      // Apply again
      return reduceStreamUpdate(s1, notification, timestamp);
    },
    [] as StreamItem[]
  );

  console.log('State 1 (applied once):', JSON.stringify(state1, null, 2));
  console.log('State 2 (applied from scratch):', JSON.stringify(state2, null, 2));
  console.log('State 3 (applied twice per update):', JSON.stringify(state3, null, 2));

  // Verify all states are equal
  const state1Str = JSON.stringify(state1);
  const state2Str = JSON.stringify(state2);
  const state3Str = JSON.stringify(state3);

  if (state1Str === state2Str && state2Str === state3Str) {
    console.log('✅ PASS: All states are identical');
  } else {
    console.log('❌ FAIL: States differ');
    console.log('State 1 === State 2:', state1Str === state2Str);
    console.log('State 2 === State 3:', state2Str === state3Str);
  }

  // Verify message accumulation worked
  const assistantMsg = state1.find(item => item.kind === 'assistant_message');
  if (assistantMsg && assistantMsg.text === 'Hello! How can I help you?') {
    console.log('✅ PASS: Message chunks accumulated correctly');
  } else {
    console.log('❌ FAIL: Message accumulation failed');
    console.log('Expected: "Hello! How can I help you?"');
    console.log('Got:', assistantMsg?.text);
  }
}

// Test 2: Duplicate user messages should not create duplicates
function testUserMessageDeduplication() {
  console.log('\n=== Test 2: User Message Deduplication ===');

  const timestamp = new Date('2025-01-01T10:00:00Z');

  // Same user message sent twice (simulating reconnection)
  const updates = [
    { notification: createUserMessageChunk('Test message', 'user-msg-1'), timestamp },
    { notification: createUserMessageChunk('Test message', 'user-msg-1'), timestamp },
  ];

  const state = hydrateStreamState(updates);

  const userMessages = state.filter(item => item.kind === 'user_message');

  console.log('User messages in state:', userMessages.length);
  console.log('State:', JSON.stringify(state, null, 2));

  if (userMessages.length === 1) {
    console.log('✅ PASS: User message deduplicated correctly');
  } else {
    console.log('❌ FAIL: Expected 1 user message, got', userMessages.length);
  }
}

// Test 3: Multiple assistant messages with different IDs
function testMultipleMessages() {
  console.log('\n=== Test 3: Multiple Distinct Messages ===');

  const timestamp1 = new Date('2025-01-01T10:00:00Z');
  const timestamp2 = new Date('2025-01-01T10:00:05Z');

  // Two separate assistant messages (new turn resets message ID)
  const updates = [
    { notification: createAgentMessageChunk('First ', 'msg-1'), timestamp: timestamp1 },
    { notification: createAgentMessageChunk('message', 'msg-1'), timestamp: timestamp1 },
    { notification: createToolCall('tool-1', 'Read file'), timestamp: timestamp1 },
    { notification: createAgentMessageChunk('Second ', 'msg-2'), timestamp: timestamp2 },
    { notification: createAgentMessageChunk('message', 'msg-2'), timestamp: timestamp2 },
  ];

  const state = hydrateStreamState(updates);

  const assistantMessages = state.filter(item => item.kind === 'assistant_message');

  console.log('Assistant messages:', assistantMessages.length);
  console.log('State:', JSON.stringify(state, null, 2));

  if (assistantMessages.length === 2 &&
      assistantMessages[0].text === 'First message' &&
      assistantMessages[1].text === 'Second message') {
    console.log('✅ PASS: Multiple messages handled correctly');
  } else {
    console.log('❌ FAIL: Expected 2 distinct messages');
  }
}

// Run all tests
console.log('Testing Idempotent Stream Reduction');
console.log('====================================');

testIdempotentReduction();
testUserMessageDeduplication();
testMultipleMessages();

console.log('\n====================================');
console.log('Tests complete');
