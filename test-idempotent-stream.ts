import { reduceStreamUpdate, hydrateStreamState, type StreamItem, type ToolCallItem } from "./packages/app/src/types/stream";

type AgentStreamEventPayload = Parameters<typeof reduceStreamUpdate>[1];

function assistantTimeline(text: string): AgentStreamEventPayload {
  return {
    type: "timeline",
    provider: "claude",
    item: { type: "assistant_message", text },
  };
}

function reasoningTimeline(text: string): AgentStreamEventPayload {
  return {
    type: "timeline",
    provider: "claude",
    item: { type: "reasoning", text },
  };
}

function toolTimeline(id: string, status: string, raw?: unknown): AgentStreamEventPayload {
  return {
    type: "timeline",
    provider: "claude",
    item: {
      type: "tool_call",
      server: "terminal",
      tool: id,
      status,
      callId: id,
      displayName: id,
      kind: "execute",
      raw,
    },
  };
}

function permissionTimeline(id: string, status: string): AgentStreamEventPayload {
  return {
    type: "timeline",
    provider: "claude",
    item: {
      type: "tool_call",
      server: "permission",
      tool: "permission_request",
      status,
      callId: id,
      displayName: "Permission",
      kind: "permission",
    },
  };
}

function userTimeline(text: string, messageId?: string): AgentStreamEventPayload {
  return {
    type: "timeline",
    provider: "claude",
    item: {
      type: "user_message",
      text,
      messageId,
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
    { event: assistantTimeline("Hello! "), timestamp: timestamp2 },
    { event: assistantTimeline("How can I help you?"), timestamp: timestamp2 },
    { event: reasoningTimeline("Thinking..."), timestamp: timestamp3 },
  ];

  // Apply updates once
  const state1 = hydrateStreamState(updates);

  // Apply same updates again from scratch
  const state2 = hydrateStreamState(updates);

  // Apply updates twice (should still be same)
  const state3 = updates.reduce(
    (state, { event, timestamp }) => {
      const s1 = reduceStreamUpdate(state, event, timestamp);
      // Apply again
      return reduceStreamUpdate(s1, event, timestamp);
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
  const assistantMsg = state1.find(item => item.kind === "assistant_message");
  if (assistantMsg && assistantMsg.text === "Hello! How can I help you?") {
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

  const timestamp = new Date("2025-01-01T10:00:00Z");

  const updates = [
    { event: toolTimeline("tool-1", "pending"), timestamp },
    { event: toolTimeline("tool-1", "completed"), timestamp },
  ];

  const state = hydrateStreamState(updates);

  const toolCalls = state.filter((item) => item.kind === "tool_call");

  console.log("Tool calls in state:", toolCalls.length);
  console.log("State:", JSON.stringify(state, null, 2));

  if (toolCalls.length === 1 && toolCalls[0].payload.source === "agent" && toolCalls[0].payload.data.status === "completed") {
    console.log("✅ PASS: Tool call consolidated correctly");
  } else {
    console.log("❌ FAIL: Expected a single completed tool call entry");
  }
}

// Test 3: Multiple assistant messages with different IDs
function testMultipleMessages() {
  console.log('\n=== Test 3: Multiple Distinct Messages ===');

  const timestamp1 = new Date("2025-01-01T10:00:00Z");
  const timestamp2 = new Date("2025-01-01T10:00:05Z");

  const updates = [
    { event: assistantTimeline("First message"), timestamp: timestamp1 },
    { event: toolTimeline("tool-2", "pending"), timestamp: timestamp1 },
    { event: toolTimeline("tool-2", "failed"), timestamp: timestamp1 },
    { event: assistantTimeline("Second message"), timestamp: timestamp2 },
  ];

  const state = hydrateStreamState(updates);

  const assistantMessages = state.filter((item) => item.kind === "assistant_message");

  console.log("Assistant messages:", assistantMessages.length);
  console.log("State:", JSON.stringify(state, null, 2));

  if (
    assistantMessages.length === 2 &&
    assistantMessages[0].text === "First message" &&
    assistantMessages[1].text === "Second message"
  ) {
    console.log("✅ PASS: Multiple messages handled correctly");
  } else {
    console.log("❌ FAIL: Expected 2 distinct messages");
  }
}

// Test 4: Tool call raw input should survive completion updates
function testToolCallInputPreservation() {
  console.log('\n=== Test 4: Tool Call Input Preservation ===');

  const timestampStart = new Date("2025-01-01T10:00:00Z");
  const timestampFinish = new Date("2025-01-01T10:00:05Z");

  const toolCallId = "tool-raw-test";
  const toolInput = {
    type: "mcp_tool_use",
    tool_use_id: toolCallId,
    input: {
      command: "pwd",
    },
  };
  const toolResult = {
    type: "mcp_tool_result",
    tool_use_id: toolCallId,
    output: {
      stdout: "/tmp",
    },
  };

  const updates = [
    { event: toolTimeline(toolCallId, "pending", toolInput), timestamp: timestampStart },
    { event: toolTimeline(toolCallId, "completed", toolResult), timestamp: timestampFinish },
  ];

  const state = hydrateStreamState(updates);
  const toolCallEntry = state.find(
    (item): item is ToolCallItem =>
      item.kind === "tool_call" && item.payload.source === "agent"
  );

  if (!toolCallEntry) {
    console.log("❌ FAIL: Tool call entry not found");
    return;
  }

  const rawPayload = toolCallEntry.payload.data.raw as Record<string, unknown> | undefined;

  const hasInput =
    !!rawPayload &&
    typeof rawPayload === "object" &&
    rawPayload !== null &&
    "input" in rawPayload;

  const preservedOriginal = rawPayload === toolInput;

  if (hasInput && preservedOriginal) {
    console.log("✅ PASS: Tool call raw input preserved after completion");
  } else {
    console.log("❌ FAIL: Tool call input was lost or replaced");
    console.log("Raw payload:", rawPayload);
  }
}

// Test 5: Assistant message chunks should preserve whitespace between words
function testAssistantWhitespacePreservation() {
  console.log('\n=== Test 5: Assistant Message Whitespace Preservation ===');

  const timestamp = new Date('2025-01-01T11:00:00Z');

  const updates = [
    { event: assistantTimeline("Hello "), timestamp },
    { event: assistantTimeline("world"), timestamp },
    { event: assistantTimeline(" !"), timestamp },
  ];

  const state = hydrateStreamState(updates);
  const assistantMsg = state.find((item) => item.kind === "assistant_message");

  if (assistantMsg && assistantMsg.text === "Hello world !") {
    console.log("✅ PASS: Assistant message whitespace preserved");
  } else {
    console.log("❌ FAIL: Expected whitespace to be preserved");
    console.log("Assistant message:", assistantMsg);
  }
}

// Test 6: User messages should persist through hydration and deduplicate with live events
function testUserMessageHydration() {
  console.log('\n=== Test 6: User Message Hydration ===');

  const timestamp = new Date('2025-01-01T11:30:00Z');
  const messageId = 'msg_user_1';

  const updates = [
    { event: userTimeline('Run npm test', messageId), timestamp },
    { event: assistantTimeline('On it!'), timestamp },
  ];

  const hydrated = hydrateStreamState(updates);
  const hydratedUser = hydrated.find((item) => item.kind === 'user_message');

  if (hydratedUser && hydratedUser.text === 'Run npm test' && hydratedUser.id === messageId) {
    console.log('✅ PASS: Hydrated stream contains persisted user message');
  } else {
    console.log('❌ FAIL: Expected user message to survive hydration');
    console.log('Hydrated state:', JSON.stringify(hydrated, null, 2));
  }

  const optimisticState: StreamItem[] = [
    { kind: 'user_message', id: messageId, text: 'Run npm test', timestamp },
  ];

  const afterServerEvent = reduceStreamUpdate(
    optimisticState,
    userTimeline('Run npm test', messageId),
    timestamp
  );

  if (afterServerEvent.length === 1 && afterServerEvent[0].kind === 'user_message') {
    console.log('✅ PASS: Duplicate server event does not create extra user entry');
  } else {
    console.log('❌ FAIL: Duplicate server event should not add another user message');
    console.log('State:', JSON.stringify(afterServerEvent, null, 2));
  }
}

// Test 7: Permission tool calls should not show in the timeline
function testPermissionToolCallFiltering() {
  console.log('\n=== Test 7: Permission Tool Call Filtering ===');

  const timestamp = new Date('2025-01-01T12:00:00Z');
  const updates = [
    { event: permissionTimeline('permission-1', 'pending'), timestamp },
    { event: permissionTimeline('permission-1', 'granted'), timestamp },
  ];

  const state = hydrateStreamState(updates);
  const permissionEntries = state.filter(
    (item) => item.kind === 'tool_call' && item.payload.source === 'agent'
  );

  if (permissionEntries.length === 0) {
    console.log('✅ PASS: Permission tool calls hidden from timeline');
  } else {
    console.log('❌ FAIL: Permission tool calls should be hidden');
    console.log('State:', JSON.stringify(state, null, 2));
  }
}

// Run all tests
console.log("Testing Idempotent Stream Reduction");
console.log("====================================");

testIdempotentReduction();
testUserMessageDeduplication();
testMultipleMessages();
testToolCallInputPreservation();
testAssistantWhitespacePreservation();
testUserMessageHydration();
testPermissionToolCallFiltering();

console.log("\n====================================");
console.log("Tests complete");
