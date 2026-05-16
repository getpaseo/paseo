import assert from "node:assert/strict";
import invariant from "tiny-invariant";
import { describe, expect, it } from "vitest";

import {
  applyStreamEvent,
  appendOptimisticUserMessageToStream,
  buildOptimisticUserMessage,
  clearOptimisticUserMessages,
  hydrateStreamState,
  mergeToolCallDetail,
  reduceStreamUpdate,
  type AgentToolCallItem,
  type StreamItem,
  isAgentToolCallItem,
} from "./stream";
import type { AgentProvider, ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import { buildToolCallDisplayModel } from "@getpaseo/protocol/tool-call-display";

type CanonicalToolStatus = "running" | "completed" | "failed" | "canceled";

function assistantTimeline(
  text: string,
  provider: AgentProvider = "claude",
  messageId?: string,
): AgentStreamEventPayload {
  return {
    type: "timeline",
    provider,
    item: { type: "assistant_message", text, ...(messageId ? { messageId } : {}) },
  };
}

function reasoningTimeline(
  text: string,
  provider: AgentProvider = "claude",
): AgentStreamEventPayload {
  return {
    type: "timeline",
    provider,
    item: { type: "reasoning", text },
  };
}

function canonicalToolTimeline(params: {
  provider: AgentProvider;
  callId: string;
  name: string;
  status: CanonicalToolStatus;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  metadata?: Record<string, unknown>;
  detail?: ToolCallDetail;
}): AgentStreamEventPayload {
  const detail: ToolCallDetail = params.detail ?? {
    type: "unknown",
    input: params.input ?? null,
    output: params.output ?? null,
  };

  const baseItem = {
    type: "tool_call" as const,
    callId: params.callId,
    name: params.name,
    status: params.status,
    detail,
    metadata: params.metadata,
  };

  const item =
    params.status === "failed"
      ? {
          ...baseItem,
          status: "failed" as const,
          error: params.error ?? { message: "failed" },
        }
      : {
          ...baseItem,
          error: null,
        };

  return {
    type: "timeline",
    provider: params.provider,
    item,
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

function findToolByCallId(state: StreamItem[], callId: string): AgentToolCallItem | undefined {
  return state.find(
    (item): item is AgentToolCallItem =>
      isAgentToolCallItem(item) && item.payload.data.callId === callId,
  );
}

describe("stream reducer tool call idempotency", () => {
  it("returns the same detail reference when tool call detail is identical", () => {
    const existing: ToolCallDetail = {
      type: "shell",
      command: "npm test",
      cwd: "/tmp/repo",
    };
    const incoming: ToolCallDetail = {
      type: "shell",
      command: "npm test",
      cwd: "/tmp/repo",
    };

    const merged = mergeToolCallDetail(existing, incoming);

    assert.strictEqual(merged, existing);
  });

  it("returns a new detail reference when tool call detail changes", () => {
    const existing: ToolCallDetail = {
      type: "shell",
      command: "npm test",
      cwd: "/tmp/repo",
    };
    const incoming: ToolCallDetail = {
      type: "shell",
      command: "npm run typecheck",
      cwd: "/tmp/repo",
    };

    const merged = mergeToolCallDetail(existing, incoming);

    assert.notStrictEqual(merged, existing);
    assert.deepStrictEqual(merged, incoming);
  });

  it("returns the same state array when status, error, detail, and metadata are identical", () => {
    const callId = "idempotent-tool-call";
    const initialState = reduceStreamUpdate(
      [],
      canonicalToolTimeline({
        provider: "codex",
        callId,
        name: "shell",
        status: "running",
        detail: {
          type: "shell",
          command: "npm test",
          cwd: "/tmp/repo",
        },
        metadata: {
          paneId: "%1",
        },
      }),
      new Date("2025-01-01T12:00:00Z"),
    );

    const nextState = reduceStreamUpdate(
      initialState,
      canonicalToolTimeline({
        provider: "codex",
        callId,
        name: "shell",
        status: "running",
        detail: {
          type: "shell",
          command: "npm test",
          cwd: "/tmp/repo",
        },
        metadata: {
          paneId: "%1",
        },
      }),
      new Date("2025-01-01T12:00:01Z"),
    );

    assert.strictEqual(nextState, initialState);
  });

  it("returns a new state array when tool call status changes", () => {
    const callId = "status-change-tool-call";
    const initialState = reduceStreamUpdate(
      [],
      canonicalToolTimeline({
        provider: "codex",
        callId,
        name: "shell",
        status: "running",
        detail: {
          type: "shell",
          command: "npm test",
        },
      }),
      new Date("2025-01-01T12:10:00Z"),
    );

    const nextState = reduceStreamUpdate(
      initialState,
      canonicalToolTimeline({
        provider: "codex",
        callId,
        name: "shell",
        status: "completed",
        detail: {
          type: "shell",
          command: "npm test",
        },
      }),
      new Date("2025-01-01T12:10:01Z"),
    );

    assert.notStrictEqual(nextState, initialState);
  });

  it("returns a new state array when tool call detail changes", () => {
    const callId = "detail-change-tool-call";
    const initialState = reduceStreamUpdate(
      [],
      canonicalToolTimeline({
        provider: "codex",
        callId,
        name: "shell",
        status: "running",
        detail: {
          type: "shell",
          command: "npm test",
        },
      }),
      new Date("2025-01-01T12:20:00Z"),
    );

    const nextState = reduceStreamUpdate(
      initialState,
      canonicalToolTimeline({
        provider: "codex",
        callId,
        name: "shell",
        status: "running",
        detail: {
          type: "shell",
          command: "npm run typecheck",
        },
      }),
      new Date("2025-01-01T12:20:01Z"),
    );

    assert.notStrictEqual(nextState, initialState);
  });

  it("returns a new state array when tool call error changes", () => {
    const callId = "error-change-tool-call";
    const initialState = reduceStreamUpdate(
      [],
      canonicalToolTimeline({
        provider: "codex",
        callId,
        name: "shell",
        status: "failed",
        error: { message: "first failure" },
        detail: {
          type: "shell",
          command: "npm test",
        },
      }),
      new Date("2025-01-01T12:30:00Z"),
    );

    const nextState = reduceStreamUpdate(
      initialState,
      canonicalToolTimeline({
        provider: "codex",
        callId,
        name: "shell",
        status: "failed",
        error: { message: "second failure" },
        detail: {
          type: "shell",
          command: "npm test",
        },
      }),
      new Date("2025-01-01T12:30:01Z"),
    );

    assert.notStrictEqual(nextState, initialState);
  });
});

describe("stream reducer canonical tool calls", () => {
  it("is deterministic for equivalent hydration sequences", () => {
    const updates = [
      {
        event: assistantTimeline("Hello "),
        timestamp: new Date("2025-01-01T10:00:00Z"),
      },
      {
        event: assistantTimeline("world"),
        timestamp: new Date("2025-01-01T10:00:01Z"),
      },
      {
        event: reasoningTimeline("Thinking..."),
        timestamp: new Date("2025-01-01T10:00:02Z"),
      },
    ];

    const first = hydrateStreamState(updates);
    const second = hydrateStreamState(updates);

    expect(first).toEqual(second);
    const assistantMessage = first.find((item) => item.kind === "assistant_message");
    assert.strictEqual(assistantMessage?.text, "Hello world");
  });

  it("keeps adjacent assistant timeline items separate when message ids differ", () => {
    const state = hydrateStreamState([
      {
        event: assistantTimeline("First answer.", "codex", "msg-first"),
        timestamp: new Date("2025-01-01T10:01:00Z"),
      },
      {
        event: assistantTimeline("Second answer.", "codex", "msg-second"),
        timestamp: new Date("2025-01-01T10:01:01Z"),
      },
    ]);

    const messages = state.filter((item) => item.kind === "assistant_message");
    assert.strictEqual(messages.length, 2);
    const first = messages[0];
    const second = messages[1];
    invariant(first?.kind === "assistant_message");
    invariant(second?.kind === "assistant_message");
    assert.deepStrictEqual([first.text, second.text], ["First answer.", "Second answer."]);
    assert.deepStrictEqual([first.messageId, second.messageId], ["msg-first", "msg-second"]);
  });

  it("merges adjacent assistant deltas when message ids match", () => {
    const state = hydrateStreamState([
      {
        event: assistantTimeline("Hel", "codex", "msg-same"),
        timestamp: new Date("2025-01-01T10:02:00Z"),
      },
      {
        event: assistantTimeline("lo", "codex", "msg-same"),
        timestamp: new Date("2025-01-01T10:02:01Z"),
      },
    ]);

    const messages = state.filter((item) => item.kind === "assistant_message");
    assert.strictEqual(messages.length, 1);
    const first = messages[0];
    invariant(first?.kind === "assistant_message");
    assert.strictEqual(first.text, "Hello");
    assert.strictEqual(first.id, "msg-same");
    assert.strictEqual(first.messageId, "msg-same");
  });

  it("preserves old assistant merge behavior when message ids are absent", () => {
    const state = hydrateStreamState([
      {
        event: assistantTimeline("Hel", "codex"),
        timestamp: new Date("2025-01-01T10:03:00Z"),
      },
      {
        event: assistantTimeline("lo", "codex"),
        timestamp: new Date("2025-01-01T10:03:01Z"),
      },
    ]);

    const messages = state.filter((item) => item.kind === "assistant_message");
    assert.strictEqual(messages.length, 1);
    const first = messages[0];
    invariant(first?.kind === "assistant_message");
    assert.strictEqual(first.text, "Hello");
  });

  it("merges running and completed events by callId", () => {
    const callId = "tool-merge-1";
    const updates = [
      {
        event: canonicalToolTimeline({
          provider: "claude",
          callId,
          name: "shell",
          status: "running",
          input: { command: "pwd" },
        }),
        timestamp: new Date("2025-01-01T10:10:00Z"),
      },
      {
        event: canonicalToolTimeline({
          provider: "claude",
          callId,
          name: "shell",
          status: "completed",
          input: null,
          output: { output: "/tmp/repo\n", exitCode: 0 },
        }),
        timestamp: new Date("2025-01-01T10:10:01Z"),
      },
    ];

    const state = hydrateStreamState(updates);
    const tools = state.filter(isAgentToolCallItem);

    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].payload.data.status, "completed");
    assert.deepStrictEqual(tools[0].payload.data.detail, {
      type: "unknown",
      input: { command: "pwd" },
      output: {
        output: "/tmp/repo\n",
        exitCode: 0,
      },
    });
  });

  it("keeps sub_agent detail through lifecycle updates for the same callId", () => {
    const callId = "task-sub-agent-1";
    const updates = [
      {
        event: canonicalToolTimeline({
          provider: "claude",
          callId,
          name: "Task",
          status: "running",
          detail: {
            type: "sub_agent",
            subAgentType: "Explore",
            description: "Inspect repository structure",
            log: "[Read] README.md\n[Bash] ls",
          },
        }),
        timestamp: new Date("2025-01-01T10:12:00Z"),
      },
      {
        event: canonicalToolTimeline({
          provider: "claude",
          callId,
          name: "Task",
          status: "completed",
          input: null,
          output: { ok: true },
        }),
        timestamp: new Date("2025-01-01T10:12:01Z"),
      },
    ];

    const state = hydrateStreamState(updates);
    const tools = state.filter(isAgentToolCallItem);

    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].payload.data.status, "completed");
    assert.deepStrictEqual(tools[0].payload.data.detail, {
      type: "sub_agent",
      subAgentType: "Explore",
      description: "Inspect repository structure",
      log: "[Read] README.md\n[Bash] ls",
    });

    const display = buildToolCallDisplayModel({
      name: tools[0].payload.data.name,
      status: tools[0].payload.data.status,
      error: tools[0].payload.data.error,
      detail: tools[0].payload.data.detail,
    });
    assert.deepStrictEqual(display, {
      displayName: "Explore",
      summary: "Inspect repository structure",
    });
  });

  it("exposes shell summary from running input before completion", () => {
    const callId = "running-summary-shell";
    const state = hydrateStreamState([
      {
        event: canonicalToolTimeline({
          provider: "claude",
          callId,
          name: "shell",
          status: "running",
          input: { command: "npm test" },
          detail: {
            type: "shell",
            command: "npm test",
          },
        }),
        timestamp: new Date("2025-01-01T10:15:00Z"),
      },
    ]);

    const tool = findToolByCallId(state, callId);
    assert.ok(tool);

    const summary = buildToolCallDisplayModel({
      name: tool.payload.data.name,
      status: tool.payload.data.status,
      error: tool.payload.data.error,
      detail: tool.payload.data.detail,
    }).summary;
    assert.strictEqual(summary, "npm test");
  });

  it("exposes file path summary from running read input before completion", () => {
    const callId = "running-summary-read";
    const state = hydrateStreamState([
      {
        event: canonicalToolTimeline({
          provider: "codex",
          callId,
          name: "read_file",
          status: "running",
          input: { path: "/tmp/repo/README.md" },
          detail: {
            type: "read",
            filePath: "/tmp/repo/README.md",
          },
        }),
        timestamp: new Date("2025-01-01T10:16:00Z"),
      },
    ]);

    const tool = findToolByCallId(state, callId);
    assert.ok(tool);

    const summary = buildToolCallDisplayModel({
      name: tool.payload.data.name,
      status: tool.payload.data.status,
      error: tool.payload.data.error,
      detail: tool.payload.data.detail,
      cwd: "/tmp/repo",
    }).summary;
    assert.strictEqual(summary, "README.md");
  });

  it("does not infer command summary when detail is absent", () => {
    const callId = "running-summary-shell-input-only";
    const state = hydrateStreamState([
      {
        event: canonicalToolTimeline({
          provider: "codex",
          callId,
          name: "exec_command",
          status: "running",
          input: { command: "npm run lint" },
          output: null,
        }),
        timestamp: new Date("2025-01-01T10:17:00Z"),
      },
    ]);

    const tool = findToolByCallId(state, callId);
    assert.ok(tool);

    const display = buildToolCallDisplayModel({
      name: tool.payload.data.name,
      status: tool.payload.data.status,
      error: tool.payload.data.error,
      detail: tool.payload.data.detail,
    });
    assert.strictEqual(display.summary, undefined);
    assert.strictEqual(display.displayName, "Exec Command");
  });

  it("preserves early input when later updates contain null input", () => {
    const callId = "null-input-preserve";
    const updates = [
      {
        event: canonicalToolTimeline({
          provider: "codex",
          callId,
          name: "read_file",
          status: "running",
          input: { path: "README.md" },
        }),
        timestamp: new Date("2025-01-01T10:20:00Z"),
      },
      {
        event: canonicalToolTimeline({
          provider: "codex",
          callId,
          name: "read_file",
          status: "completed",
          input: null,
          output: { content: "hello" },
        }),
        timestamp: new Date("2025-01-01T10:20:01Z"),
      },
    ];

    const state = hydrateStreamState(updates);
    const tool = findToolByCallId(state, callId);

    assert.ok(tool);
    assert.deepStrictEqual(tool.payload.data.detail, {
      type: "unknown",
      input: { path: "README.md" },
      output: { content: "hello" },
    });
    assert.strictEqual(tool.payload.data.status, "completed");
  });

  it("keeps terminal status when a stale running update arrives later", () => {
    const callId = "out-of-order";
    const updates = [
      {
        event: canonicalToolTimeline({
          provider: "codex",
          callId,
          name: "shell",
          status: "completed",
          input: { command: "ls" },
          output: { output: "README.md" },
        }),
        timestamp: new Date("2025-01-01T10:30:00Z"),
      },
      {
        event: canonicalToolTimeline({
          provider: "codex",
          callId,
          name: "shell",
          status: "running",
          input: { command: "ls" },
          output: null,
        }),
        timestamp: new Date("2025-01-01T10:30:01Z"),
      },
    ];

    const state = hydrateStreamState(updates);
    const tool = findToolByCallId(state, callId);

    assert.ok(tool);
    assert.strictEqual(tool.payload.data.status, "completed");
  });

  it("does not duplicate tool pills during hydration replay", () => {
    const callId = "replay-dedupe";
    const start = canonicalToolTimeline({
      provider: "claude",
      callId,
      name: "shell",
      status: "running",
      input: { command: "echo hi" },
    });
    const finish = canonicalToolTimeline({
      provider: "claude",
      callId,
      name: "shell",
      status: "completed",
      output: { output: "hi" },
      input: null,
    });

    const updates = [
      { event: start, timestamp: new Date("2025-01-01T10:40:00Z") },
      { event: finish, timestamp: new Date("2025-01-01T10:40:01Z") },
      { event: start, timestamp: new Date("2025-01-01T10:40:02Z") },
      { event: finish, timestamp: new Date("2025-01-01T10:40:03Z") },
    ];

    const state = hydrateStreamState(updates);
    const tools = state.filter(isAgentToolCallItem);

    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].payload.data.callId, callId);
    assert.strictEqual(tools[0].payload.data.status, "completed");
  });

  it("converts todo timeline updates to todo_list", () => {
    const state = hydrateStreamState([
      {
        event: todoTimeline([
          { text: "Outline", completed: false },
          { text: "Ship", completed: true },
        ]),
        timestamp: new Date("2025-01-01T10:50:00Z"),
      },
    ]);

    const todos = state.find(
      (item): item is Extract<StreamItem, { kind: "todo_list" }> => item.kind === "todo_list",
    );

    assert.ok(todos);
    assert.strictEqual(todos.items.length, 2);
    assert.strictEqual(todos.items[1]?.completed, true);
  });

  it("renders Claude TodoWrite as todo_list and suppresses tool call badge", () => {
    const state = hydrateStreamState([
      {
        event: canonicalToolTimeline({
          provider: "claude",
          callId: "todo-write",
          name: "TodoWrite",
          status: "running",
          input: {
            todos: [
              { content: "Task 1", status: "pending" },
              { content: "Task 2", status: "completed" },
            ],
          },
        }),
        timestamp: new Date("2025-01-01T11:00:00Z"),
      },
    ]);

    const tools = state.filter(isAgentToolCallItem);
    const todos = state.find(
      (item): item is Extract<StreamItem, { kind: "todo_list" }> => item.kind === "todo_list",
    );

    assert.strictEqual(tools.length, 0);
    assert.ok(todos);
    assert.strictEqual(todos.items[0]?.text, "Task 1");
  });

  it("preserves optimistic user message images when authoritative user message arrives", () => {
    const messageId = "msg-user-images";
    const optimisticTimestamp = new Date("2025-01-01T11:10:00Z");
    const optimisticImages = [
      {
        id: "att-optimistic",
        mimeType: "image/jpeg",
        storageType: "native-file" as const,
        storageKey: "/tmp/optimistic.jpg",
        createdAt: Date.now(),
      },
    ];
    const initialState: StreamItem[] = [
      {
        kind: "user_message",
        id: messageId,
        text: "Analyze this image",
        timestamp: optimisticTimestamp,
        optimistic: true,
        images: optimisticImages,
      },
    ];
    const event: AgentStreamEventPayload = {
      type: "timeline",
      provider: "claude",
      item: {
        type: "user_message",
        text: "Analyze this image",
        messageId,
      },
    };
    const authoritativeTimestamp = new Date("2025-01-01T11:10:01Z");

    const state = reduceStreamUpdate(initialState, event, authoritativeTimestamp);
    const message = state.find((item) => item.kind === "user_message");

    assert.ok(message);
    assert.strictEqual(message.id, messageId);
    assert.deepStrictEqual(message.images, optimisticImages);
    assert.strictEqual(message.text, "Analyze this image");
    assert.strictEqual(message.timestamp.getTime(), optimisticTimestamp.getTime());
  });

  it("keeps canonical assistant/user/assistant order during replay", () => {
    const state: StreamItem[] = [
      {
        kind: "assistant_message",
        id: "a1",
        text: "Saved that preference. ",
        timestamp: new Date("2025-01-01T11:20:00Z"),
      },
      {
        kind: "user_message",
        id: "u1",
        text: "the other qeustion is i mgiht be thinking that its winner takes it all",
        timestamp: new Date("2025-01-01T11:20:01Z"),
      },
    ];

    const event: AgentStreamEventPayload = {
      type: "timeline",
      provider: "claude",
      item: {
        type: "assistant_message",
        text: "Right. And it probably isn't.",
      },
    };

    const next = reduceStreamUpdate(state, event, new Date("2025-01-01T11:20:02Z"), {
      source: "canonical",
    });

    assert.deepStrictEqual(
      next.map((item) => item.kind),
      ["assistant_message", "user_message", "assistant_message"],
    );
    assert.strictEqual(
      next[0]?.kind === "assistant_message" ? next[0].text : null,
      "Saved that preference. ",
    );
    assert.strictEqual(
      next[2]?.kind === "assistant_message" ? next[2].text : null,
      "Right. And it probably isn't.",
    );
  });

  it("keeps live optimistic assistant merge behavior", () => {
    const state: StreamItem[] = [
      {
        kind: "assistant_message",
        id: "a1",
        text: "Saved that preference. ",
        timestamp: new Date("2025-01-01T11:21:00Z"),
      },
      {
        kind: "user_message",
        id: "u1",
        text: "the other qeustion is i mgiht be thinking that its winner takes it all",
        timestamp: new Date("2025-01-01T11:21:01Z"),
      },
    ];

    const event: AgentStreamEventPayload = {
      type: "timeline",
      provider: "claude",
      item: {
        type: "assistant_message",
        text: "Right. And it probably isn't.",
      },
    };

    const next = reduceStreamUpdate(state, event, new Date("2025-01-01T11:21:02Z"), {
      source: "live",
    });

    assert.deepStrictEqual(
      next.map((item) => item.kind),
      ["assistant_message", "user_message"],
    );
    assert.strictEqual(
      next[0]?.kind === "assistant_message" ? next[0].text : null,
      "Saved that preference. Right. And it probably isn't.",
    );
  });
});

describe("turn lifecycle events", () => {
  it("finalizes active stream items without adding timeline rows", () => {
    const startedAt = new Date("2025-01-01T12:00:00Z");
    const completedAt = new Date("2025-01-01T12:00:05Z");

    let state = reduceStreamUpdate([], { type: "turn_started", provider: "claude" }, startedAt);
    state = reduceStreamUpdate(
      state,
      { type: "timeline", provider: "claude", item: { type: "assistant_message", text: "ok" } },
      new Date("2025-01-01T12:00:02Z"),
    );
    state = reduceStreamUpdate(state, { type: "turn_completed", provider: "claude" }, completedAt);

    assert.deepStrictEqual(
      state.map((item) => item.kind),
      ["assistant_message"],
    );
  });

  it("hydrates canonical timeline rows without synthetic turn rows", () => {
    const state = hydrateStreamState([
      {
        event: {
          type: "timeline",
          provider: "claude",
          item: { type: "user_message", text: "hi" },
        },
        timestamp: new Date("2025-01-01T13:00:00Z"),
      },
      {
        event: assistantTimeline("Working on it.", "claude", "msg-1"),
        timestamp: new Date("2025-01-01T13:00:01Z"),
      },
      {
        event: assistantTimeline("Done.", "claude", "msg-2"),
        timestamp: new Date("2025-01-01T13:00:04Z"),
      },
    ]);

    assert.deepStrictEqual(
      state.map((item) => item.kind),
      ["user_message", "assistant_message", "assistant_message"],
    );
  });

  it("does not materialize turn_started events during hydration", () => {
    const startedAt = new Date("2025-01-01T14:00:00Z");
    const state = hydrateStreamState([
      {
        event: {
          type: "timeline",
          provider: "claude",
          item: { type: "user_message", text: "hi" },
        },
        timestamp: new Date("2025-01-01T13:59:59Z"),
      },
      { event: { type: "turn_started", provider: "claude" }, timestamp: startedAt },
      {
        event: assistantTimeline("ok", "claude", "msg-1"),
        timestamp: new Date("2025-01-01T14:00:02Z"),
      },
    ]);

    assert.deepStrictEqual(
      state.map((item) => item.kind),
      ["user_message", "assistant_message"],
    );
  });

  it("keeps adjacent user messages as adjacent timeline rows", () => {
    const state = hydrateStreamState([
      {
        event: {
          type: "timeline",
          provider: "claude",
          item: { type: "user_message", text: "hi" },
        },
        timestamp: new Date("2025-01-01T15:00:00Z"),
      },
      {
        event: {
          type: "timeline",
          provider: "claude",
          item: { type: "user_message", text: "still there?" },
        },
        timestamp: new Date("2025-01-01T15:01:00Z"),
      },
    ]);

    assert.deepStrictEqual(
      state.map((item) => item.kind),
      ["user_message", "user_message"],
    );
  });

  it.each(["codex", "opencode", "pi"] satisfies AgentProvider[])(
    "replaces an optimistic user message when a live %s provider-owned id echo arrives without text matching",
    (provider) => {
      const optimisticTimestamp = new Date("2025-01-01T15:02:00Z");
      const serverTimestamp = new Date("2025-01-01T15:02:01Z");
      const optimistic: StreamItem = {
        kind: "user_message",
        id: "msg_optimistic",
        text: "same user text",
        timestamp: optimisticTimestamp,
        optimistic: true,
        images: [
          {
            id: "image-1",
            mimeType: "image/png",
            storageType: "web-indexeddb",
            storageKey: "image-1",
            createdAt: optimisticTimestamp.getTime(),
          },
        ],
        attachments: [
          {
            type: "text",
            mimeType: "text/plain",
            text: "attached context",
            title: "context.txt",
          },
        ],
      };

      const state = reduceStreamUpdate(
        [optimistic],
        {
          type: "timeline",
          provider,
          item: {
            type: "user_message",
            text: "server-owned rendered text",
            messageId: "provider-owned-id",
          },
        },
        serverTimestamp,
        { source: "live" },
      );

      const userMessages = state.filter((item) => item.kind === "user_message");
      assert.strictEqual(userMessages.length, 1);
      const userMessage = userMessages[0];
      invariant(userMessage?.kind === "user_message");
      assert.strictEqual(userMessage.id, "provider-owned-id");
      assert.strictEqual(userMessage.text, optimistic.text);
      assert.strictEqual(userMessage.timestamp.getTime(), optimistic.timestamp.getTime());
      assert.strictEqual(userMessage.optimistic, undefined);
      assert.deepStrictEqual(userMessage.images, optimistic.images);
      assert.deepStrictEqual(userMessage.attachments, optimistic.attachments);
    },
  );

  it("replaces one optimistic plain-text user message with the next live server user message", () => {
    const optimisticTimestamp = new Date("2025-01-01T15:03:00Z");
    const serverTimestamp = new Date("2025-01-01T15:03:01Z");
    const optimistic: StreamItem = {
      kind: "user_message",
      id: "msg_optimistic",
      text: "typed plain text",
      timestamp: optimisticTimestamp,
      optimistic: true,
    };

    const state = reduceStreamUpdate(
      [optimistic],
      {
        type: "timeline",
        provider: "opencode",
        item: {
          type: "user_message",
          text: "typed plain text",
          messageId: "msg_opencode_provider_owned",
        },
      },
      serverTimestamp,
      { source: "live" },
    );

    const userMessages = state.filter((item) => item.kind === "user_message");
    assert.strictEqual(userMessages.length, 1);
    const userMessage = userMessages[0];
    invariant(userMessage?.kind === "user_message");
    assert.strictEqual(userMessage.id, "msg_opencode_provider_owned");
    assert.strictEqual(userMessage.text, "typed plain text");
    assert.strictEqual(userMessage.timestamp.getTime(), optimisticTimestamp.getTime());
    assert.strictEqual(userMessage.optimistic, undefined);
  });

  it("replaces an optimistic image user message with the next canonical server user message", () => {
    const optimisticTimestamp = new Date("2025-01-01T15:03:10Z");
    const image = {
      id: "image-canonical",
      mimeType: "image/png",
      storageType: "web-indexeddb" as const,
      storageKey: "image-canonical",
      createdAt: optimisticTimestamp.getTime(),
    };
    const attachment = {
      type: "text" as const,
      mimeType: "text/plain" as const,
      text: "context",
      title: "context.txt",
    };
    const optimistic = buildOptimisticUserMessage({
      id: "msg_optimistic_canonical",
      text: "Analyze this",
      timestamp: optimisticTimestamp,
      images: [image],
      attachments: [attachment],
    });

    const state = reduceStreamUpdate(
      [optimistic],
      {
        type: "timeline",
        provider: "claude",
        item: {
          type: "user_message",
          text: "server-rendered attachment text",
          messageId: "provider-owned-canonical",
        },
      },
      new Date("2025-01-01T15:03:11Z"),
      { source: "canonical" },
    );

    const userMessages = state.filter((item) => item.kind === "user_message");
    assert.strictEqual(userMessages.length, 1);
    const userMessage = userMessages[0];
    invariant(userMessage?.kind === "user_message");
    assert.strictEqual(userMessage.id, "provider-owned-canonical");
    assert.strictEqual(userMessage.text, "Analyze this");
    assert.strictEqual(userMessage.timestamp.getTime(), optimisticTimestamp.getTime());
    assert.strictEqual(userMessage.optimistic, undefined);
    assert.deepStrictEqual(userMessage.images, [image]);
    assert.deepStrictEqual(userMessage.attachments, [attachment]);
  });

  it("places optimistic user messages through one append helper", () => {
    const optimistic = buildOptimisticUserMessage({
      id: "msg_append_once",
      text: "append once",
      timestamp: new Date("2025-01-01T15:03:20Z"),
    });
    const headItem: StreamItem = {
      kind: "assistant_message",
      id: "assistant-head",
      text: "streaming",
      timestamp: new Date("2025-01-01T15:03:19Z"),
    };

    const first = appendOptimisticUserMessageToStream({
      tail: [],
      head: [headItem],
      message: optimistic,
      placement: "active-head",
    });
    const second = appendOptimisticUserMessageToStream({
      tail: first.tail,
      head: first.head,
      message: optimistic,
      placement: "active-head",
    });
    const skipped = appendOptimisticUserMessageToStream({
      tail: [
        {
          kind: "user_message",
          id: "canonical-user",
          text: "already canonical",
          timestamp: new Date("2025-01-01T15:03:21Z"),
        },
      ],
      head: [],
      message: optimistic,
      placement: "tail",
      skipIfUserMessageExists: true,
    });

    assert.deepStrictEqual(first.tail, []);
    assert.deepStrictEqual(first.head, [headItem, optimistic]);
    assert.strictEqual(second.changedHead, false);
    assert.strictEqual(second.head, first.head);
    assert.strictEqual(skipped.changedTail, false);
    assert.strictEqual(skipped.tail.length, 1);
  });

  it("reconciles an optimistic user message that was pending in the streaming head", () => {
    const optimistic: StreamItem = {
      kind: "user_message",
      id: "msg_head_optimistic",
      text: "plain text in head",
      timestamp: new Date("2025-01-01T15:03:02Z"),
      optimistic: true,
    };

    const result = applyStreamEvent({
      tail: [],
      head: [optimistic],
      event: {
        type: "timeline",
        provider: "opencode",
        item: {
          type: "user_message",
          text: "plain text in head",
          messageId: "provider-owned-head",
        },
      },
      timestamp: new Date("2025-01-01T15:03:03Z"),
      source: "live",
    });

    assert.strictEqual(result.head.length, 0);
    const userMessages = result.tail.filter((item) => item.kind === "user_message");
    assert.strictEqual(userMessages.length, 1);
    assert.strictEqual(userMessages[0]?.id, "provider-owned-head");
    assert.strictEqual(userMessages[0]?.optimistic, undefined);
  });

  it("replaces multiple optimistic user messages in FIFO order", () => {
    const optimisticTimestamp = new Date("2025-01-01T15:04:00Z");
    const serverTimestamp = new Date("2025-01-01T15:04:01Z");
    const firstOptimistic: StreamItem = {
      kind: "user_message",
      id: "msg_optimistic_1",
      text: "first typed text",
      timestamp: optimisticTimestamp,
      optimistic: true,
    };
    const secondOptimistic: StreamItem = {
      kind: "user_message",
      id: "msg_optimistic_2",
      text: "second typed text",
      timestamp: new Date("2025-01-01T15:04:00.500Z"),
      optimistic: true,
    };

    const afterFirstEcho = reduceStreamUpdate(
      [firstOptimistic, secondOptimistic],
      {
        type: "timeline",
        provider: "opencode",
        item: {
          type: "user_message",
          text: "first server text",
          messageId: "provider-owned-first",
        },
      },
      serverTimestamp,
      { source: "live" },
    );
    const state = reduceStreamUpdate(
      afterFirstEcho,
      {
        type: "timeline",
        provider: "opencode",
        item: {
          type: "user_message",
          text: "second server text",
          messageId: "provider-owned-second",
        },
      },
      new Date("2025-01-01T15:04:02Z"),
      { source: "live" },
    );

    const userMessages = state.filter((item) => item.kind === "user_message");
    assert.strictEqual(userMessages.length, 2);
    assert.deepStrictEqual(
      userMessages.map((item) => [item.id, item.text, item.optimistic]),
      [
        ["provider-owned-first", "first typed text", undefined],
        ["provider-owned-second", "second typed text", undefined],
      ],
    );
  });

  it("appends a live server user message when no optimistic user message is pending", () => {
    const state = reduceStreamUpdate(
      [],
      {
        type: "timeline",
        provider: "opencode",
        item: {
          type: "user_message",
          text: "resumed session text",
          messageId: "provider-owned-resume",
        },
      },
      new Date("2025-01-01T15:04:03Z"),
      { source: "live" },
    );

    const userMessages = state.filter((item) => item.kind === "user_message");
    assert.strictEqual(userMessages.length, 1);
    assert.strictEqual(userMessages[0]?.id, "provider-owned-resume");
    assert.strictEqual(userMessages[0]?.optimistic, undefined);
  });

  it("does not match a server user message to an optimistic from a rewound turn after pending optimistics are cleared", () => {
    const optimistic: StreamItem = {
      kind: "user_message",
      id: "msg_rewound_optimistic",
      text: "rewound text",
      timestamp: new Date("2025-01-01T15:04:04Z"),
      optimistic: true,
    };
    const cleared = clearOptimisticUserMessages([optimistic]);

    const state = reduceStreamUpdate(
      cleared,
      {
        type: "timeline",
        provider: "opencode",
        item: {
          type: "user_message",
          text: "future server echo",
          messageId: "provider-owned-after-rewind",
        },
      },
      new Date("2025-01-01T15:04:05Z"),
      { source: "live" },
    );

    const userMessages = state.filter((item) => item.kind === "user_message");
    assert.strictEqual(userMessages.length, 1);
    assert.strictEqual(userMessages[0]?.id, "provider-owned-after-rewind");
    assert.strictEqual(userMessages[0]?.text, "future server echo");
    assert.strictEqual(userMessages[0]?.optimistic, undefined);
  });

  it("keeps canonical repeated user messages distinct during hydration", () => {
    const state = hydrateStreamState(
      [
        {
          event: {
            type: "timeline",
            provider: "codex",
            item: { type: "user_message", text: "repeat", messageId: "native-1" },
          },
          timestamp: new Date("2025-01-01T15:03:00Z"),
        },
        {
          event: {
            type: "timeline",
            provider: "codex",
            item: { type: "user_message", text: "repeat", messageId: "native-2" },
          },
          timestamp: new Date("2025-01-01T15:03:01Z"),
        },
      ],
      { source: "canonical" },
    );

    const userMessages = state.filter((item) => item.kind === "user_message");
    assert.strictEqual(userMessages.length, 2);
    assert.deepStrictEqual(
      userMessages.map((item) => item.id),
      ["native-1", "native-2"],
    );
  });
});
