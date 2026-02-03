import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  reduceStreamUpdate,
  hydrateStreamState,
  type StreamItem,
  type ToolCallItem,
  type TodoListItem,
  type AgentToolCallItem,
  isAgentToolCallItem,
} from "./stream";

type AgentStreamEventPayload = Parameters<typeof reduceStreamUpdate>[1];
type TestAgentProvider = "claude" | "codex";

function expectAgentToolCallItem(
  item: ToolCallItem | undefined,
  message = "Expected agent tool call"
): asserts item is AgentToolCallItem {
  assert.ok(item, message);
  assert.ok(isAgentToolCallItem(item), message);
}

function assistantTimeline(text: string, provider: TestAgentProvider = "claude"): AgentStreamEventPayload {
  return {
    type: "timeline",
    provider,
    item: { type: "assistant_message", text },
  };
}

function reasoningTimeline(text: string, provider: TestAgentProvider = "claude"): AgentStreamEventPayload {
  return {
    type: "timeline",
    provider,
    item: { type: "reasoning", text },
  };
}

function toolTimeline(
  id: string,
  status: string,
  _raw?: unknown,
  options?: { callId?: string | null; provider?: "claude" | "codex"; name?: string }
): AgentStreamEventPayload {
  const explicitCallIdProvided =
    options && Object.prototype.hasOwnProperty.call(options, "callId");
  const callIdValue = explicitCallIdProvided
    ? options?.callId === null
      ? undefined
      : options?.callId
    : id;
  const provider = options?.provider ?? "claude";
  const name = options?.name ?? id;
  return {
    type: "timeline",
    provider,
    item: {
      type: "tool_call",
      name,
      status,
      callId: callIdValue,
    },
  };
}

function toolTimelineWithInput(options: {
  provider: TestAgentProvider;
  name: string;
  status: string;
  callId?: string;
  input: unknown;
}): AgentStreamEventPayload {
  return {
    type: "timeline",
    provider: options.provider,
    item: {
      type: "tool_call",
      name: options.name,
      status: options.status,
      callId: options.callId ?? options.name,
      input: options.input,
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

function userTimeline(text: string, messageId?: string, provider: TestAgentProvider = "claude"): AgentStreamEventPayload {
  return {
    type: "timeline",
    provider,
    item: {
      type: "user_message",
      text,
      messageId,
    },
  };
}

// Test 1: Same updates applied twice should be idempotent
function testIdempotentReduction() {
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

  const state1Str = JSON.stringify(state1);
  const state2Str = JSON.stringify(state2);

  const assistantMsg = state1.find(item => item.kind === "assistant_message");
  assert.strictEqual(state1Str, state2Str, "Hydrated stream should be deterministic");
  assert.strictEqual(
    assistantMsg?.text,
    "Hello! How can I help you?",
    "Assistant chunks should concatenate with preserved spacing"
  );
}

// Test 2: Duplicate user messages should not create duplicates
function testUserMessageDeduplication() {
  const timestamp = new Date("2025-01-01T10:00:00Z");

  const updates = [
    { event: toolTimeline("tool-1", "pending"), timestamp },
    { event: toolTimeline("tool-1", "completed"), timestamp },
  ];

  const state = hydrateStreamState(updates);

  const toolCalls = state.filter(isAgentToolCallItem);

  assert.strictEqual(toolCalls.length, 1, "Pending/completed tool entries should reconcile");
  assert.strictEqual(toolCalls[0].payload.source, "agent");
  assert.strictEqual(toolCalls[0].payload.data.status, "completed");
}

// Test 3: Multiple assistant messages with different IDs
function testMultipleMessages() {
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

  assert.strictEqual(assistantMessages.length, 2, "Assistant messages should remain distinct");
  assert.strictEqual(assistantMessages[0].text, "First message");
  assert.strictEqual(assistantMessages[1].text, "Second message");
}

// Test 4: Tool call raw input should survive completion updates
// Test 5: Completed tool calls without status should infer completion for hydrated state
function testToolCallStatusInference() {
  const toolCallId = 'tool-completion';
  const timestamp1 = new Date('2025-01-01T10:10:00Z');
  const timestamp2 = new Date('2025-01-01T10:10:05Z');

  const startEvent: AgentStreamEventPayload = {
    type: 'timeline',
    provider: 'claude',
    item: {
      type: 'tool_call',
      name: 'read',
      status: 'pending',
      callId: toolCallId,
    },
  };

  const completionEvent: AgentStreamEventPayload = {
    type: 'timeline',
    provider: 'claude',
    item: {
      type: 'tool_call',
      name: 'read',
      callId: toolCallId,
      output: { content: 'Hello world' },
    },
  };

  const state = hydrateStreamState([
    { event: startEvent, timestamp: timestamp1 },
    { event: completionEvent, timestamp: timestamp2 },
  ]);

  const toolEntry = state.find(
    (item): item is AgentToolCallItem =>
      isAgentToolCallItem(item) && item.payload.data.callId === toolCallId
  );

  assert.ok(toolEntry, "Tool entry should exist after hydration");
  assert.strictEqual(toolEntry.payload.data.status, 'completed');
  assert.strictEqual(
    (toolEntry.payload.data.result as { content?: string }).content,
    'Hello world'
  );
}

function testToolCallStatusInferenceFromRawOnly() {
  const toolCallId = 'raw-status';
  const timestamp = new Date('2025-01-01T10:20:00Z');

  const rawEvent: AgentStreamEventPayload = {
    type: 'timeline',
    provider: 'claude',
    item: {
      type: 'tool_call',
      name: 'shell',
      callId: toolCallId,
      status: 'completed',
      output: { metadata: { exit_code: 0 } },
    },
  };

  const state = hydrateStreamState([{ event: rawEvent, timestamp }]);
  const toolEntry = state.find(isAgentToolCallItem);

  assert.strictEqual(toolEntry?.payload.data.status, 'completed');
}

function testToolCallFailureInferenceFromError() {
  const toolCallId = 'raw-error';
  const timestamp = new Date('2025-01-01T10:25:00Z');

  const rawEvent: AgentStreamEventPayload = {
    type: 'timeline',
    provider: 'claude',
    item: {
      type: 'tool_call',
      name: 'shell',
      callId: toolCallId,
      error: { message: 'Command failed' },
    },
  };

  const state = hydrateStreamState([{ event: rawEvent, timestamp }]);
  const toolEntry = state.find(isAgentToolCallItem);
  expectAgentToolCallItem(toolEntry);
  assert.strictEqual(toolEntry.payload.data.status, 'failed');
}

function testToolCallLateCallIdReconciliation() {
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
  const toolCalls = state.filter(isAgentToolCallItem);

  assert.strictEqual(toolCalls.length, 1, 'late call ids should merge entries');
  assert.strictEqual(toolCalls[0].payload.data.status, 'completed');
  assert.strictEqual(toolCalls[0].payload.data.callId, 'late-call');
}

function testToolCallParsedPayloadHydration() {
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
          name: 'read_file',
          status: 'pending',
          callId: readCallId,
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
          name: 'read_file',
          callId: readCallId,
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
          name: 'shell',
          status: 'pending',
          callId: commandCallId,
          input: { command: 'pwd' },
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
          name: 'shell',
          callId: commandCallId,
          output: {
            result: {
              command: 'pwd',
              output: '/Users/dev/paseo',
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
    (item): item is AgentToolCallItem =>
      isAgentToolCallItem(item) && item.payload.data.callId === readCallId
  );
  const commandEntry = state.find(
    (item): item is AgentToolCallItem =>
      isAgentToolCallItem(item) && item.payload.data.callId === commandCallId
  );

  const readPass = Boolean(
    readEntry?.payload.data.parsedReads &&
      readEntry.payload.data.parsedReads.length === 1 &&
      readEntry.payload.data.parsedReads[0]?.content.includes('Hello world')
  );

  const commandPass = Boolean(
    commandEntry?.payload.data.parsedCommand &&
      commandEntry.payload.data.parsedCommand.command === 'pwd' &&
      commandEntry.payload.data.parsedCommand.output?.includes('/paseo')
  );

  assert.ok(readPass, 'Read payload should persist across hydration');
  assert.ok(commandPass, 'Command payload should persist across hydration');
}

function buildClaudeToolUseBlock({
  id,
  name,
  server,
  input,
}: {
  id: string;
  name: string;
  server: string;
  input: Record<string, unknown>;
}) {
  return {
    type: 'mcp_tool_use',
    id,
    name,
    server,
    input,
  };
}

function buildClaudeToolResultBlock({
  toolUseId,
  server,
  toolName,
  content,
  isError,
}: {
  toolUseId: string;
  server: string;
  toolName: string;
  content: Array<Record<string, unknown>>;
  isError?: boolean;
}) {
  return {
    type: 'mcp_tool_result',
    tool_use_id: toolUseId,
    server,
    tool_name: toolName,
    is_error: Boolean(isError),
    content,
  };
}

function testClaudeHydratedToolBodies() {
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
          name: 'apply_patch',
          status: 'pending',
          callId: editCallId,
          input: {
            file_path: 'src/example.ts',
            patch: '*** Begin Patch...',
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
          name: 'apply_patch',
          callId: editCallId,
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
          name: 'read_file',
          status: 'pending',
          callId: readCallId,
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
          name: 'read_file',
          callId: readCallId,
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
          name: 'shell',
          status: 'pending',
          callId: commandCallId,
          input: { command: 'ls' },
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
          name: 'shell',
          callId: commandCallId,
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
    (item): item is AgentToolCallItem =>
      isAgentToolCallItem(item) && item.payload.data.callId === editCallId
  );
  const readEntry = state.find(
    (item): item is AgentToolCallItem =>
      isAgentToolCallItem(item) && item.payload.data.callId === readCallId
  );
  const commandEntry = state.find(
    (item): item is AgentToolCallItem =>
      isAgentToolCallItem(item) && item.payload.data.callId === commandCallId
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

  assert.ok(editHasDiff, 'Edit tool should expose parsed diff payloads');
  assert.ok(readHasContent, 'Read tool should expose hydrated file content');
  assert.ok(commandHasOutput, 'Command tool should expose hydrated stdout');
}

// Test 6: Assistant message chunks should preserve whitespace between words
function testAssistantWhitespacePreservation() {
  const timestamp = new Date('2025-01-01T11:00:00Z');

  const updates = [
    { event: assistantTimeline("Hello "), timestamp },
    { event: assistantTimeline("world"), timestamp },
    { event: assistantTimeline(" !"), timestamp },
  ];

  const state = hydrateStreamState(updates);
  const assistantMsg = state.find((item) => item.kind === "assistant_message");

  assert.strictEqual(assistantMsg?.text, "Hello world !");
}

// Test 7: User messages should persist through hydration and deduplicate with live events
function testUserMessageHydration() {
  const timestamp = new Date('2025-01-01T11:30:00Z');
  const messageId = 'msg_user_1';

  const updates = [
    { event: userTimeline('Run npm test', messageId), timestamp },
    { event: assistantTimeline('On it!'), timestamp },
  ];

  const hydrated = hydrateStreamState(updates);
  const hydratedUser = hydrated.find((item) => item.kind === 'user_message');

  assert.strictEqual(hydratedUser?.text, 'Run npm test');
  assert.strictEqual(hydratedUser?.id, messageId);

  const optimisticState: StreamItem[] = [
    { kind: 'user_message', id: messageId, text: 'Run npm test', timestamp },
  ];

  const afterServerEvent = reduceStreamUpdate(
    optimisticState,
    userTimeline('Run npm test', messageId),
    timestamp
  );

  assert.strictEqual(afterServerEvent.length, 1);
  assert.strictEqual(afterServerEvent[0].kind, 'user_message');
}

function testHydratedUserMessagesPersist() {
  (['claude', 'codex'] as const).forEach((provider) => {
    const snapshotTimestamp = new Date('2025-01-01T12:15:00Z');
    const snapshot = [
      { event: userTimeline('Tell me more', undefined, provider), timestamp: snapshotTimestamp },
      { event: userTimeline('Tell me more', undefined, provider), timestamp: snapshotTimestamp },
      { event: assistantTimeline('Sure thing', provider), timestamp: snapshotTimestamp },
    ];

    const hydrated = hydrateStreamState(snapshot);
    const hydratedUsers = hydrated.filter((item) => item.kind === 'user_message');

    assert.strictEqual(
      hydratedUsers.length,
      2,
      `${provider} hydrated snapshots should retain duplicate-text user entries`
    );

    const replayed = reduceStreamUpdate(
      hydrated,
      assistantTimeline('Continuing after hydration', provider),
      new Date('2025-01-01T12:16:00Z')
    );
    const replayedUsers = replayed.filter((item) => item.kind === 'user_message');

    assert.strictEqual(
      replayedUsers.length,
      2,
      `${provider} live updates should preserve hydrated user entries`
    );
  });
}

// Test 8: Todo lists should consolidate into a single entry and update completions
function testTodoListConsolidation() {
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

  assert.strictEqual(todoEntries.length, 1);
  assert.ok(
    todoEntries[0].items.some(
      (entry) => entry.text === 'Outline approach' && entry.completed
    ),
    'Todo entries should consolidate into a single list'
  );
}

function testTodoWriteToolCallCreatesTodoList() {
  const timestamp = new Date("2025-01-01T12:32:00Z");
  const event = toolTimelineWithInput({
    provider: "claude",
    name: "TodoWrite",
    status: "completed",
    input: {
      todos: [
        { content: "First task", status: "pending" },
        { content: "Second task", status: "completed" },
      ],
    },
  });

  const state = reduceStreamUpdate([], event, timestamp);
  const todoEntries = state.filter(
    (item): item is TodoListItem => item.kind === "todo_list"
  );
  const toolCalls = state.filter((item) => item.kind === "tool_call");

  assert.strictEqual(todoEntries.length, 1);
  assert.strictEqual(
    toolCalls.length,
    0,
    "TodoWrite should render as a task list, not a tool call"
  );
  assert.ok(
    todoEntries[0].items.some(
      (entry) => entry.text === "First task" && !entry.completed
    )
  );
  assert.ok(
    todoEntries[0].items.some(
      (entry) => entry.text === "Second task" && entry.completed
    )
  );
}

function testTodoWriteToolCallExecutingDoesNotRenderToolCall() {
  const timestamp = new Date("2025-01-01T12:32:00Z");
  const event = toolTimelineWithInput({
    provider: "claude",
    name: "TodoWrite",
    status: "executing",
    input: {
      todos: [{ content: "Task", status: "pending" }],
    },
  });

  const state = reduceStreamUpdate([], event, timestamp);
  const todoEntries = state.filter(
    (item): item is TodoListItem => item.kind === "todo_list"
  );
  const toolCalls = state.filter((item) => item.kind === "tool_call");

  assert.strictEqual(todoEntries.length, 1);
  assert.strictEqual(
    toolCalls.length,
    0,
    "TodoWrite (executing) should not render as a tool call"
  );
}

function testTimelineIdStabilityAfterRemovals() {
  const timestamp = new Date('2025-01-01T12:35:00Z');

  // Assistant stream entries
  let assistantState: StreamItem[] = [];
  for (let i = 0; i < 4; i += 1) {
    assistantState = reduceStreamUpdate(
      assistantState,
      userTimeline(`assistant-prefill-${i}`),
      timestamp
    );
  }
  assistantState = reduceStreamUpdate(
    assistantState,
    assistantTimeline('Repeatable assistant text'),
    timestamp
  );
  assistantState = reduceStreamUpdate(
    assistantState,
    userTimeline('assistant-separator'),
    timestamp
  );
  assistantState = assistantState.filter(
    (item) =>
      !(
        item.kind === 'user_message' &&
        (item.text === 'assistant-prefill-0' || item.text === 'assistant-prefill-1')
      )
  );
  assistantState = reduceStreamUpdate(
    assistantState,
    assistantTimeline('Repeatable assistant text'),
    timestamp
  );

  const assistantIds = assistantState
    .filter((item) => item.kind === 'assistant_message')
    .map((item) => item.id);
  const assistantUnique = new Set(assistantIds);

  assert.strictEqual(
    assistantIds.length,
    assistantUnique.size,
    'Assistant ids should stay unique after state shrink'
  );

  // Thought stream entries
  let thoughtState: StreamItem[] = [];
  for (let i = 0; i < 3; i += 1) {
    thoughtState = reduceStreamUpdate(
      thoughtState,
      userTimeline(`thought-prefill-${i}`),
      timestamp
    );
  }
  thoughtState = reduceStreamUpdate(
    thoughtState,
    reasoningTimeline('Repeatable reasoning text'),
    timestamp
  );
  thoughtState = reduceStreamUpdate(
    thoughtState,
    userTimeline('thought-separator'),
    timestamp
  );
  thoughtState = thoughtState.filter(
    (item) =>
      !(
        item.kind === 'user_message' &&
        (item.text === 'thought-prefill-0' || item.text === 'thought-prefill-1')
      )
  );
  thoughtState = reduceStreamUpdate(
    thoughtState,
    reasoningTimeline('Repeatable reasoning text'),
    timestamp
  );

  const thoughtIds = thoughtState
    .filter((item) => item.kind === 'thought')
    .map((item) => item.id);
  const thoughtUnique = new Set(thoughtIds);

  assert.strictEqual(
    thoughtIds.length,
    thoughtUnique.size,
    'Thought ids should stay unique after state shrink'
  );
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
    name: 'shell',
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
): AgentToolCallItem[] {
  const finalState =
    mode === 'live'
      ? updates.reduce<StreamItem[]>((state, { event, timestamp }) => {
          return reduceStreamUpdate(state, event, timestamp);
        }, [])
      : hydrateStreamState(updates);

  return finalState.filter(isAgentToolCallItem);
}

function testToolCallDeduplicationLive() {
  (['claude', 'codex'] as const).forEach((provider) => {
    const updates = buildConcurrentToolCallUpdates(provider);
    const toolCalls = validateToolCallDeduplication(updates, 'live');
    const callIds = toolCalls.map((entry) => entry.payload.data.callId).filter(Boolean);
    const statuses = toolCalls.map((entry) => entry.payload.data.status);

    assert.strictEqual(toolCalls.length, 2, `${provider} live tool calls should dedupe`);
    assert.ok(
      callIds.includes(`${provider}-tool-1`) && callIds.includes(`${provider}-tool-2`),
      `${provider} live stream should retain tool call identifiers`
    );
    assert.ok(
      statuses.every((status) => status === 'completed'),
      `${provider} live stream should mark calls as completed`
    );
  });
}

function testToolCallDeduplicationHydrated() {
  (['claude', 'codex'] as const).forEach((provider) => {
    const updates = buildConcurrentToolCallUpdates(provider);
    const toolCalls = validateToolCallDeduplication(updates, 'hydrated');
    const callIds = toolCalls.map((entry) => entry.payload.data.callId).filter(Boolean);
    const statuses = toolCalls.map((entry) => entry.payload.data.status);

    assert.strictEqual(toolCalls.length, 2, `${provider} hydration should dedupe tool calls`);
    assert.ok(
      callIds.includes(`${provider}-tool-1`) && callIds.includes(`${provider}-tool-2`),
      `${provider} hydration should retain tool call identifiers`
    );
    assert.ok(
      statuses.every((status) => status === 'completed'),
      `${provider} hydration should mark calls completed`
    );
  });
}

function buildOutOfOrderToolCallSequence(provider: ToolCallProvider) {
  const timestamps = [
    new Date('2025-01-01T13:00:00Z'),
    new Date('2025-01-01T13:00:05Z'),
  ];
  const callId = `${provider}-out-of-order`;
  return [
    {
      event: toolTimeline(
        'shell',
        'completed',
        { type: 'tool_result', provider, tool_call_id: callId },
        { provider, name: 'shell', callId }
      ),
      timestamp: timestamps[0],
    },
    {
      event: toolTimeline(
        'shell',
        'executing',
        { type: 'tool_use', provider },
        { provider, name: 'shell', callId: null }
      ),
      timestamp: timestamps[1],
    },
  ];
}

function testOutOfOrderToolCallMergingLive() {
  (['claude', 'codex'] as const).forEach((provider) => {
    const updates = buildOutOfOrderToolCallSequence(provider);
    const finalState = updates.reduce<StreamItem[]>((state, { event, timestamp }) => {
      return reduceStreamUpdate(state, event, timestamp);
    }, []);
    const toolCalls = finalState.filter(isAgentToolCallItem);
    assert.strictEqual(toolCalls.length, 1, `${provider} live stream should not duplicate out-of-order calls`);
    assert.strictEqual(toolCalls[0]?.payload.data.status, 'completed', `${provider} live stream should keep completed status`);
  });
}

function testOutOfOrderToolCallMergingHydrated() {
  (['claude', 'codex'] as const).forEach((provider) => {
    const updates = buildOutOfOrderToolCallSequence(provider);
    const hydrated = hydrateStreamState(updates);
    const toolCalls = hydrated.filter(isAgentToolCallItem);
    assert.strictEqual(toolCalls.length, 1, `${provider} hydration should not duplicate out-of-order calls`);
    assert.strictEqual(toolCalls[0]?.payload.data.status, 'completed', `${provider} hydration should keep completed status`);
  });
}

function buildMetadataReplaySequence(provider: ToolCallProvider) {
  const timestamps = [
    new Date('2025-01-01T14:00:00Z'),
    new Date('2025-01-01T14:00:02Z'),
    new Date('2025-01-01T14:00:04Z'),
  ];
  const firstCallId = `${provider}-metadata-1`;
  const secondCallId = `${provider}-metadata-2`;
  return [
    {
      event: toolTimeline(
        'shell',
        'completed',
        { type: 'tool_result', provider, tool_call_id: firstCallId },
        { provider, name: 'shell', callId: firstCallId }
      ),
      timestamp: timestamps[0],
    },
    {
      event: toolTimeline(
        'shell',
        'completed',
        { type: 'tool_result', provider, tool_call_id: secondCallId },
        { provider, name: 'shell', callId: secondCallId }
      ),
      timestamp: timestamps[1],
    },
    {
      event: toolTimeline(
        'shell',
        'executing',
        { type: 'tool_use', provider },
        { provider, name: 'shell', callId: null }
      ),
      timestamp: timestamps[2],
    },
  ];
}

function validateMetadataReplayDeduplication(
  updates: Array<{ event: AgentStreamEventPayload; timestamp: Date }>,
  mode: 'live' | 'hydrated'
): AgentToolCallItem[] {
  const finalState =
    mode === 'live'
      ? updates.reduce<StreamItem[]>((state, { event, timestamp }) => {
          return reduceStreamUpdate(state, event, timestamp);
        }, [])
      : hydrateStreamState(updates);

  return finalState.filter(isAgentToolCallItem);
}

function testMetadataReplayDeduplicationLive() {
  (['claude', 'codex'] as const).forEach((provider) => {
    const toolCalls = validateMetadataReplayDeduplication(
      buildMetadataReplaySequence(provider),
      'live'
    );
    assert.strictEqual(toolCalls.length, 2, `${provider} live replay should not add duplicate tool pills`);
    assert.strictEqual(toolCalls[0]?.payload.data.status, 'completed', `${provider} live replay should keep the original completion status`);
    assert.strictEqual(toolCalls[1]?.payload.data.status, 'completed', `${provider} live replay should keep later completion intact`);
  });
}

function testMetadataReplayDeduplicationHydrated() {
  (['claude', 'codex'] as const).forEach((provider) => {
    const toolCalls = validateMetadataReplayDeduplication(
      buildMetadataReplaySequence(provider),
      'hydrated'
    );
    assert.strictEqual(toolCalls.length, 2, `${provider} hydration replay should not add duplicate tool pills`);
    assert.strictEqual(toolCalls[0]?.payload.data.status, 'completed', `${provider} hydration replay should keep the original completion status`);
    assert.strictEqual(toolCalls[1]?.payload.data.status, 'completed', `${provider} hydration replay should keep later completion intact`);
  });
}

function testFallbackToolCallIdsStayUnique() {
  const timestamp = new Date('2025-01-01T14:05:00Z');
  // Tool calls need different name to remain distinct when lacking callIds
  const updates = [
    {
      event: toolTimeline(
        'fallback-read',
        'completed',
        undefined,
        { callId: null, name: 'read_file' }
      ),
      timestamp,
    },
    {
      event: toolTimeline(
        'fallback-shell',
        'completed',
        undefined,
        { callId: null, name: 'shell' }
      ),
      timestamp,
    },
  ];

  const hydrated = hydrateStreamState(updates);
  const toolCalls = hydrated.filter(isAgentToolCallItem);

  assert.strictEqual(toolCalls.length, 2, 'Hydration should retain multiple fallback tool entries');
  const ids = toolCalls.map((item) => item.id);
  assert.strictEqual(
    new Set(ids).size,
    ids.length,
    'Fallback-generated tool ids must be unique when name differs'
  );
}

describe('stream timeline reducers', () => {
  it('produces deterministic hydration results', testIdempotentReduction);
  it('deduplicates pending/completed tool entries in place', testUserMessageDeduplication);
  it('preserves distinct assistant messages', testMultipleMessages);
  it('infers completion from tool result payloads', testToolCallStatusInference);
  it('infers completion from output metadata', testToolCallStatusInferenceFromRawOnly);
  it('infers failure from error payloads', testToolCallFailureInferenceFromError);
  it('reconciles late call IDs against pending entries', testToolCallLateCallIdReconciliation);
  it('persists parsed read/edit/command payloads after hydration', testToolCallParsedPayloadHydration);
  it('hydrates Claude tool bodies with parsed content', testClaudeHydratedToolBodies);
  it('preserves whitespace in assistant chunk concatenation', testAssistantWhitespacePreservation);
  it('hydrates user messages and deduplicates optimistic/live entries', testUserMessageHydration);
  it('retains hydrated user messages across providers', testHydratedUserMessagesPersist);
  it('consolidates todo list updates', testTodoListConsolidation);
  it('renders TodoWrite as a task list', testTodoWriteToolCallCreatesTodoList);
  it(
    "does not render TodoWrite (executing) as a tool call",
    testTodoWriteToolCallExecutingDoesNotRenderToolCall
  );
  it('keeps timeline ids stable after list shrinkage', testTimelineIdStabilityAfterRemovals);
  it('deduplicates live tool call entries', testToolCallDeduplicationLive);
  it('deduplicates hydrated tool call entries', testToolCallDeduplicationHydrated);
  it('merges out-of-order tool call updates without duplicating entries (live)', testOutOfOrderToolCallMergingLive);
  it('merges out-of-order tool call updates without duplicating entries (hydrated)', testOutOfOrderToolCallMergingHydrated);
  it('replays metadata-only tool calls without duplicating entries (live)', testMetadataReplayDeduplicationLive);
  it('replays metadata-only tool calls without duplicating entries (hydrated)', testMetadataReplayDeduplicationHydrated);
  it('assigns unique ids for fallback tool calls without call ids', testFallbackToolCallIdsStayUnique);
});
