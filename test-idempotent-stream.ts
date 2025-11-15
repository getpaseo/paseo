import {
  reduceStreamUpdate,
  hydrateStreamState,
  type StreamItem,
  type ToolCallItem,
  type TodoListItem,
} from "./packages/app/src/types/stream";

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

function toolTimeline(
  id: string,
  status: string,
  raw?: unknown,
  options?: { callId?: string | null; provider?: "claude" | "codex"; server?: string; tool?: string; displayName?: string; kind?: string }
): AgentStreamEventPayload {
  const explicitCallIdProvided =
    options && Object.prototype.hasOwnProperty.call(options, "callId");
  const callIdValue = explicitCallIdProvided
    ? options?.callId === null
      ? undefined
      : options?.callId
    : id;
  const provider = options?.provider ?? "claude";
  return {
    type: "timeline",
    provider,
    item: {
      type: "tool_call",
      server: options?.server ?? "terminal",
      tool: options?.tool ?? id,
      status,
      callId: callIdValue,
      displayName: options?.displayName ?? id,
      kind: options?.kind ?? "execute",
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

function todoTimeline(items: { text: string; completed: boolean }[]): AgentStreamEventPayload {
  return {
    type: "timeline",
    provider: "codex",
    item: {
      type: "todo",
      items,
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

  const rawPayload = toolCallEntry.payload.data.raw as unknown;

  const isArrayPayload = Array.isArray(rawPayload);
  const containsInput = isArrayPayload && rawPayload[0] === toolInput;
  const containsResult = isArrayPayload && rawPayload[1] === toolResult;

  if (isArrayPayload && containsInput && containsResult) {
    console.log("✅ PASS: Tool call raw input/output preserved after completion");
  } else {
    console.log("❌ FAIL: Tool call raw data missing input or output");
    console.log("Raw payload:", rawPayload);
  }
}

// Test 5: Completed tool calls without status should infer completion for hydrated state
function testToolCallStatusInference() {
  console.log('\n=== Test 5: Tool Call Status Inference ===');

  const toolCallId = 'tool-completion';
  const timestamp1 = new Date('2025-01-01T10:10:00Z');
  const timestamp2 = new Date('2025-01-01T10:10:05Z');

  const startEvent: AgentStreamEventPayload = {
    type: 'timeline',
    provider: 'claude',
    item: {
      type: 'tool_call',
      server: 'editor',
      tool: 'read',
      status: 'pending',
      callId: toolCallId,
      raw: { type: 'tool_use', tool_use_id: toolCallId, input: { file_path: 'README.md' } },
    },
  };

  const completionEvent: AgentStreamEventPayload = {
    type: 'timeline',
    provider: 'claude',
    item: {
      type: 'tool_call',
      server: 'editor',
      tool: 'read',
      callId: toolCallId,
      raw: { type: 'tool_result', tool_use_id: toolCallId, output: { content: 'Hello world' } },
      output: { content: 'Hello world' },
    },
  };

  const state = hydrateStreamState([
    { event: startEvent, timestamp: timestamp1 },
    { event: completionEvent, timestamp: timestamp2 },
  ]);

  const toolEntry = state.find(
    (item): item is ToolCallItem =>
      item.kind === 'tool_call' && item.payload.source === 'agent' && item.payload.data.callId === toolCallId
  );

  if (
    toolEntry &&
    toolEntry.payload.data.status === 'completed' &&
    toolEntry.payload.data.result &&
    (toolEntry.payload.data.result as { content?: string }).content === 'Hello world'
  ) {
    console.log('✅ PASS: Missing status inferred from output and completion payload kept');
  } else {
    console.log('❌ FAIL: Expected inferred completion status and output');
    console.log('State:', JSON.stringify(state, null, 2));
  }
}

function testToolCallStatusInferenceFromRawOnly() {
  console.log('\n=== Test 5b: Tool Call Status From Raw Payload ===');

  const toolCallId = 'raw-status';
  const timestamp = new Date('2025-01-01T10:20:00Z');

  const rawEvent: AgentStreamEventPayload = {
    type: 'timeline',
    provider: 'claude',
    item: {
      type: 'tool_call',
      server: 'command',
      tool: 'shell',
      callId: toolCallId,
      raw: {
        type: 'mcp_tool_result',
        tool_use_id: toolCallId,
        result: { metadata: { exit_code: 0 } },
      },
    },
  };

  const state = hydrateStreamState([{ event: rawEvent, timestamp }]);
  const toolEntry = state.find(
    (item): item is ToolCallItem =>
      item.kind === 'tool_call' && item.payload.source === 'agent'
  );

  if (toolEntry?.payload.data.status === 'completed') {
    console.log('✅ PASS: Raw payload exit code inferred completion');
  } else {
    console.log('❌ FAIL: Expected completed status inferred from raw payload');
    console.log('State:', JSON.stringify(state, null, 2));
  }
}

function testToolCallFailureInferenceFromRaw() {
  console.log('\n=== Test 5c: Tool Call Failure From Raw Payload ===');

  const toolCallId = 'raw-error';
  const timestamp = new Date('2025-01-01T10:25:00Z');

  const rawEvent: AgentStreamEventPayload = {
    type: 'timeline',
    provider: 'claude',
    item: {
      type: 'tool_call',
      server: 'command',
      tool: 'shell',
      callId: toolCallId,
      raw: {
        type: 'mcp_tool_result',
        tool_use_id: toolCallId,
        is_error: true,
        error: {
          message: 'Command failed',
        },
      },
    },
  };

  const state = hydrateStreamState([{ event: rawEvent, timestamp }]);
  const toolEntry = state.find(
    (item): item is ToolCallItem =>
      item.kind === 'tool_call' && item.payload.source === 'agent'
  );

  if (toolEntry?.payload.data.status === 'failed') {
    console.log('✅ PASS: Raw payload error inferred failure');
  } else {
    console.log('❌ FAIL: Expected failed status inferred from raw payload');
    console.log('State:', JSON.stringify(state, null, 2));
  }
}

function testToolCallLateCallIdReconciliation() {
  console.log('\n=== Test 5d: Tool Call Late Call ID Reconciliation ===');

  const timestampStart = new Date('2025-01-01T10:15:00Z');
  const timestampFinish = new Date('2025-01-01T10:15:05Z');

  const updates = [
    {
      event: toolTimeline('late-call', 'pending', { foo: 'bar' }, { callId: null }),
      timestamp: timestampStart,
    },
    { event: toolTimeline('late-call', 'completed'), timestamp: timestampFinish },
  ];

  const state = hydrateStreamState(updates);
  const toolCalls = state.filter(
    (item): item is ToolCallItem =>
      item.kind === 'tool_call' && item.payload.source === 'agent'
  );

  if (
    toolCalls.length === 1 &&
    toolCalls[0].payload.data.status === 'completed' &&
    toolCalls[0].payload.data.callId === 'late-call'
  ) {
    console.log('✅ PASS: Tool call updates reconcile when call IDs arrive late');
  } else {
    console.log(
      '❌ FAIL: Late call IDs should update existing entries instead of duplicating'
    );
    console.log('State:', JSON.stringify(state, null, 2));
  }
}

function testToolCallParsedPayloadHydration() {
  console.log('\n=== Test 5e: Tool Call Parsed Payload Hydration ===');

  const timestampStart = new Date('2025-01-01T10:35:00Z');
  const timestampFinish = new Date('2025-01-01T10:35:05Z');

  const readCallId = 'parsed-read';
  const commandCallId = 'parsed-command';

  const updates: Array<{ event: AgentStreamEventPayload; timestamp: Date }> = [
    {
      event: {
        type: 'timeline',
        provider: 'claude',
        item: {
          type: 'tool_call',
          server: 'editor',
          tool: 'read_file',
          status: 'pending',
          callId: readCallId,
          raw: {
            type: 'tool_use',
            tool_use_id: readCallId,
            input: { file_path: 'README.md' },
          },
          input: { file_path: 'README.md' },
        },
      },
      timestamp: timestampStart,
    },
    {
      event: {
        type: 'timeline',
        provider: 'claude',
        item: {
          type: 'tool_call',
          server: 'editor',
          tool: 'read_file',
          callId: readCallId,
          raw: {
            type: 'tool_result',
            tool_use_id: readCallId,
            output: { content: 'Hello world' },
          },
          output: { content: 'Hello world' },
        },
      },
      timestamp: timestampFinish,
    },
    {
      event: {
        type: 'timeline',
        provider: 'claude',
        item: {
          type: 'tool_call',
          server: 'command',
          tool: 'shell',
          status: 'pending',
          callId: commandCallId,
          raw: {
            type: 'tool_use',
            tool_use_id: commandCallId,
            input: { command: 'pwd' },
          },
          input: { command: 'pwd' },
          kind: 'execute',
        },
      },
      timestamp: timestampStart,
    },
    {
      event: {
        type: 'timeline',
        provider: 'claude',
        item: {
          type: 'tool_call',
          server: 'command',
          tool: 'shell',
          callId: commandCallId,
          raw: {
            type: 'tool_result',
            tool_use_id: commandCallId,
            result: {
              command: 'pwd',
              output: '/Users/dev/voice-dev',
            },
            metadata: { exit_code: 0 },
          },
          output: {
            result: {
              command: 'pwd',
              output: '/Users/dev/voice-dev',
            },
            metadata: { exit_code: 0 },
          },
        },
      },
      timestamp: timestampFinish,
    },
  ];

  const state = hydrateStreamState(updates);
  const readEntry = state.find(
    (item): item is ToolCallItem =>
      item.kind === 'tool_call' &&
      item.payload.source === 'agent' &&
      item.payload.data.callId === readCallId
  );
  const commandEntry = state.find(
    (item): item is ToolCallItem =>
      item.kind === 'tool_call' &&
      item.payload.source === 'agent' &&
      item.payload.data.callId === commandCallId
  );

  const readPass = Boolean(
    readEntry?.payload.data.parsedReads &&
      readEntry.payload.data.parsedReads.length === 1 &&
      readEntry.payload.data.parsedReads[0]?.content.includes('Hello world')
  );

  const commandPass = Boolean(
    commandEntry?.payload.data.parsedCommand &&
      commandEntry.payload.data.parsedCommand.command === 'pwd' &&
      commandEntry.payload.data.parsedCommand.output?.includes('/voice-dev')
  );

  if (readPass && commandPass) {
    console.log('✅ PASS: Parsed read and command payloads persist through hydration');
  } else {
    console.log('❌ FAIL: Expected parsed payloads to be available after hydration');
    console.log('State:', JSON.stringify(state, null, 2));
  }
}

function testClaudeHydratedToolBodies() {
  console.log('\n=== Test 5f: Claude Hydrated Tool Bodies ===');

  const timestampStart = new Date('2025-01-01T10:40:00Z');
  const timestampFinish = new Date('2025-01-01T10:40:05Z');

  const editCallId = 'claude-edit-hydration';
  const readCallId = 'claude-read-hydration';
  const commandCallId = 'claude-command-hydration';

  const updates: Array<{ event: AgentStreamEventPayload; timestamp: Date }> = [
    {
      event: {
        type: 'timeline',
        provider: 'claude',
        item: {
          type: 'tool_call',
          server: 'editor',
          tool: 'apply_patch',
          status: 'pending',
          callId: editCallId,
          raw: {
            type: 'tool_use',
            tool_use_id: editCallId,
            input: {
              file_path: 'src/example.ts',
              patch: '*** Begin Patch...'
            },
          },
        },
      },
      timestamp: timestampStart,
    },
    {
      event: {
        type: 'timeline',
        provider: 'claude',
        item: {
          type: 'tool_call',
          server: 'editor',
          tool: 'apply_patch',
          callId: editCallId,
          raw: {
            type: 'tool_result',
            tool_use_id: editCallId,
            output: {
              changes: [
                {
                  file_path: 'src/example.ts',
                  previous_content: 'export const answer = 41;\n',
                  content: 'export const answer = 42;\n',
                },
              ],
            },
          },
          output: {
            changes: [
              {
                file_path: 'src/example.ts',
                previous_content: 'export const answer = 41;\n',
                content: 'export const answer = 42;\n',
              },
            ],
          },
        },
      },
      timestamp: timestampFinish,
    },
    {
      event: {
        type: 'timeline',
        provider: 'claude',
        item: {
          type: 'tool_call',
          server: 'editor',
          tool: 'read_file',
          status: 'pending',
          callId: readCallId,
          raw: {
            type: 'tool_use',
            tool_use_id: readCallId,
            input: { file_path: 'README.md' },
          },
        },
      },
      timestamp: timestampStart,
    },
    {
      event: {
        type: 'timeline',
        provider: 'claude',
        item: {
          type: 'tool_call',
          server: 'editor',
          tool: 'read_file',
          callId: readCallId,
          raw: {
            type: 'tool_result',
            tool_use_id: readCallId,
            output: { content: '# Hydrated test file\nHello Claude!' },
          },
          output: { content: '# Hydrated test file\nHello Claude!' },
        },
      },
      timestamp: timestampFinish,
    },
    {
      event: {
        type: 'timeline',
        provider: 'claude',
        item: {
          type: 'tool_call',
          server: 'command',
          tool: 'shell',
          status: 'pending',
          callId: commandCallId,
          raw: {
            type: 'tool_use',
            tool_use_id: commandCallId,
            input: { command: 'ls' },
          },
          kind: 'execute',
        },
      },
      timestamp: timestampStart,
    },
    {
      event: {
        type: 'timeline',
        provider: 'claude',
        item: {
          type: 'tool_call',
          server: 'command',
          tool: 'shell',
          callId: commandCallId,
          raw: {
            type: 'tool_result',
            tool_use_id: commandCallId,
            result: {
              command: 'ls',
              output: 'README.md\npackages\n',
            },
            metadata: { exit_code: 0 },
          },
          output: {
            result: {
              command: 'ls',
              output: 'README.md\npackages\n',
            },
            metadata: { exit_code: 0 },
          },
        },
      },
      timestamp: timestampFinish,
    },
  ];

  const state = hydrateStreamState(updates);
  const editEntry = state.find(
    (item): item is ToolCallItem =>
      item.kind === 'tool_call' &&
      item.payload.source === 'agent' &&
      item.payload.data.callId === editCallId
  );
  const readEntry = state.find(
    (item): item is ToolCallItem =>
      item.kind === 'tool_call' &&
      item.payload.source === 'agent' &&
      item.payload.data.callId === readCallId
  );
  const commandEntry = state.find(
    (item): item is ToolCallItem =>
      item.kind === 'tool_call' &&
      item.payload.source === 'agent' &&
      item.payload.data.callId === commandCallId
  );

  const editHasDiff = Boolean(
    editEntry?.payload.data.parsedEdits &&
      editEntry.payload.data.parsedEdits.length > 0 &&
      editEntry.payload.data.parsedEdits[0]?.diffLines.length
  );
  const readHasContent = Boolean(
    readEntry?.payload.data.parsedReads &&
      readEntry.payload.data.parsedReads.length > 0 &&
      readEntry.payload.data.parsedReads[0]?.content.includes('Hydrated test file')
  );
  const commandHasOutput = Boolean(
    commandEntry?.payload.data.parsedCommand &&
      commandEntry.payload.data.parsedCommand.command === 'ls' &&
      commandEntry.payload.data.parsedCommand.output?.includes('README.md')
  );

  if (editHasDiff && readHasContent && commandHasOutput) {
    console.log('✅ PASS: Claude hydration surfaces diff, read, and command bodies');
  } else {
    console.log('❌ FAIL: Expected hydrated Claude stream to expose tool body content');
    console.log('State:', JSON.stringify(state, null, 2));
  }
}

// Test 6: Assistant message chunks should preserve whitespace between words
function testAssistantWhitespacePreservation() {
  console.log('\n=== Test 6: Assistant Message Whitespace Preservation ===');

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

// Test 7: User messages should persist through hydration and deduplicate with live events
function testUserMessageHydration() {
  console.log('\n=== Test 7: User Message Hydration ===');

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

// Test 8: Permission tool calls should not show in the timeline
function testPermissionToolCallFiltering() {
  console.log('\n=== Test 8: Permission Tool Call Filtering ===');

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

// Test 9: Todo lists should consolidate into a single entry and update completions
function testTodoListConsolidation() {
  console.log('\n=== Test 9: Todo List Consolidation ===');

  const timestamp1 = new Date('2025-01-01T12:30:00Z');
  const timestamp2 = new Date('2025-01-01T12:31:00Z');

  const firstPlan = [
    { text: 'Outline approach', completed: false },
    { text: 'Write code', completed: false },
  ];

  const secondPlan = [
    { text: 'Outline approach', completed: true },
    { text: 'Write code', completed: false },
  ];

  const updates = [
    { event: todoTimeline(firstPlan), timestamp: timestamp1 },
    { event: todoTimeline(secondPlan), timestamp: timestamp2 },
  ];

  const state = hydrateStreamState(updates);
  const todoEntries = state.filter(
    (item): item is TodoListItem => item.kind === 'todo_list'
  );

  if (
    todoEntries.length === 1 &&
    todoEntries[0].items.some(
      (entry) => entry.text === 'Outline approach' && entry.completed
    )
  ) {
    console.log('✅ PASS: Todo list updates consolidate and reflect completion');
  } else {
    console.log('❌ FAIL: Todo list entries were not consolidated as expected');
    console.log('State:', JSON.stringify(state, null, 2));
  }
}

type ToolCallProvider = 'claude' | 'codex';

function buildConcurrentToolCallUpdates(provider: ToolCallProvider) {
  const timestamps = [
    new Date('2025-01-01T12:40:00Z'),
    new Date('2025-01-01T12:40:05Z'),
    new Date('2025-01-01T12:40:10Z'),
    new Date('2025-01-01T12:40:15Z'),
  ];

  const baseOptions = {
    provider,
    server: 'command',
    tool: 'shell',
    displayName: 'Run command',
    kind: 'execute',
  } as const;

  return [
    {
      event: toolTimeline(
        'shell',
        'executing',
        { type: 'tool_use', provider, step: 'start-1' },
        { ...baseOptions, callId: null }
      ),
      timestamp: timestamps[0],
    },
    {
      event: toolTimeline(
        'shell',
        'executing',
        { type: 'tool_use', provider, step: 'start-2' },
        { ...baseOptions, callId: null }
      ),
      timestamp: timestamps[1],
    },
    {
      event: toolTimeline(
        'shell',
        'completed',
        { type: 'tool_result', provider, step: 'finish-1' },
        { ...baseOptions, callId: `${provider}-tool-1` }
      ),
      timestamp: timestamps[2],
    },
    {
      event: toolTimeline(
        'shell',
        'completed',
        { type: 'tool_result', provider, step: 'finish-2' },
        { ...baseOptions, callId: `${provider}-tool-2` }
      ),
      timestamp: timestamps[3],
    },
  ];
}

function validateToolCallDeduplication(
  updates: Array<{ event: AgentStreamEventPayload; timestamp: Date }>,
  mode: 'live' | 'hydrated'
): ToolCallItem[] {
  const finalState =
    mode === 'live'
      ? updates.reduce<StreamItem[]>((state, { event, timestamp }) => {
          return reduceStreamUpdate(state, event, timestamp);
        }, [])
      : hydrateStreamState(updates);

  return finalState.filter(
    (item): item is ToolCallItem =>
      item.kind === 'tool_call' && item.payload.source === 'agent'
  );
}

function testToolCallDeduplicationLive() {
  console.log('\n=== Test 10: Tool Call Deduplication (Live) ===');
  (['claude', 'codex'] as const).forEach((provider) => {
    const updates = buildConcurrentToolCallUpdates(provider);
    const toolCalls = validateToolCallDeduplication(updates, 'live');
    const callIds = toolCalls.map((entry) => entry.payload.data.callId).filter(Boolean);
    const statuses = toolCalls.map((entry) => entry.payload.data.status);

    if (
      toolCalls.length === 2 &&
      callIds.includes(`${provider}-tool-1`) &&
      callIds.includes(`${provider}-tool-2`) &&
      statuses.every((status) => status === 'completed')
    ) {
      console.log(`✅ PASS: ${provider} live stream deduped tool calls`);
    } else {
      console.log(`❌ FAIL: ${provider} live stream still duplicates tool calls`);
      console.log('State:', JSON.stringify(toolCalls, null, 2));
    }
  });
}

function testToolCallDeduplicationHydrated() {
  console.log('\n=== Test 11: Tool Call Deduplication (Hydrated) ===');
  (['claude', 'codex'] as const).forEach((provider) => {
    const updates = buildConcurrentToolCallUpdates(provider);
    const toolCalls = validateToolCallDeduplication(updates, 'hydrated');
    const callIds = toolCalls.map((entry) => entry.payload.data.callId).filter(Boolean);
    const statuses = toolCalls.map((entry) => entry.payload.data.status);

    if (
      toolCalls.length === 2 &&
      callIds.includes(`${provider}-tool-1`) &&
      callIds.includes(`${provider}-tool-2`) &&
      statuses.every((status) => status === 'completed')
    ) {
      console.log(`✅ PASS: ${provider} hydration deduped tool calls`);
    } else {
      console.log(`❌ FAIL: ${provider} hydration still duplicates tool calls`);
      console.log('State:', JSON.stringify(toolCalls, null, 2));
    }
  });
}

// Run all tests
console.log("Testing Idempotent Stream Reduction");
console.log("====================================");

testIdempotentReduction();
testUserMessageDeduplication();
testMultipleMessages();
testToolCallInputPreservation();
testToolCallStatusInference();
testToolCallStatusInferenceFromRawOnly();
testToolCallFailureInferenceFromRaw();
testToolCallLateCallIdReconciliation();
testToolCallParsedPayloadHydration();
testClaudeHydratedToolBodies();
testAssistantWhitespacePreservation();
testUserMessageHydration();
testPermissionToolCallFiltering();
testTodoListConsolidation();
testToolCallDeduplicationLive();
testToolCallDeduplicationHydrated();

console.log("\n====================================");
console.log("Tests complete");
