import assert from "node:assert/strict";
import invariant from "tiny-invariant";
import { describe, expect, it } from "vitest";

import {
  applyStreamEvent,
  createUserMessage,
  handoffCreatedAgentUserMessageToStream,
  hydrateStreamState,
  mergeToolCallDetail,
  reduceStreamUpdate,
  streamTimelineItemIdentity,
  type AgentToolCallItem,
  type StreamItem,
  isAgentToolCallItem,
  upsertUserMessage,
  upsertUserMessageAcrossStream,
} from "./stream";
import type { AgentProvider, ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import { buildToolCallDisplayModel } from "@getpaseo/protocol/tool-call-display";
import { timelineItemIdentity } from "@getpaseo/protocol/timeline-identity";

type CanonicalToolStatus = "running" | "completed" | "failed" | "canceled";

describe("plugin timeline rows", () => {
  it("uses the protocol identity format for stream tool and plugin rows", () => {
    const tool = {
      kind: "tool_call",
      id: "tool-row",
      timestamp: new Date(1),
      payload: {
        source: "agent",
        data: {
          provider: "codex",
          callId: "call-1",
          name: "read",
          status: "running",
          error: null,
          detail: { type: "unknown", input: null, output: null },
        },
      },
    } satisfies StreamItem;
    const plugin = {
      kind: "plugin",
      id: "review/row-1",
      pluginId: "review",
      pluginItemId: "row-1",
      itemKind: "review",
      version: 1,
      data: {},
      timestamp: new Date(1),
    } satisfies StreamItem;

    expect(streamTimelineItemIdentity(tool)).toBe(
      timelineItemIdentity({ type: "tool_call", ...tool.payload.data }),
    );
    expect(streamTimelineItemIdentity(plugin)).toBe(
      timelineItemIdentity({
        type: "plugin",
        id: plugin.pluginItemId,
        pluginId: plugin.pluginId,
        kind: plugin.itemKind,
        version: plugin.version,
        data: plugin.data,
      }),
    );
  });

  it("replaces a live row when the plugin-scoped identity repeats", () => {
    const first = reduceStreamUpdate(
      [],
      {
        type: "timeline",
        provider: "codex",
        item: {
          type: "plugin",
          id: "review-1",
          pluginId: "review",
          kind: "review",
          version: 1,
          data: { status: "running" },
        },
      },
      new Date(1),
    );
    const second = reduceStreamUpdate(
      first,
      {
        type: "timeline",
        provider: "codex",
        item: {
          type: "plugin",
          id: "review-1",
          pluginId: "review",
          kind: "review",
          version: 1,
          data: { status: "complete" },
        },
      },
      new Date(2),
    );

    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      kind: "plugin",
      id: "review/review-1",
      pluginId: "review",
      pluginItemId: "review-1",
      data: { status: "complete" },
    });
  });
});

describe("user message identity", () => {
  it("replaces provisional optimistic turn membership with canonical membership", () => {
    const optimistic = createUserMessage({
      clientMessageId: "hello-client",
      text: "hello",
      timestamp: new Date("2026-08-15T10:00:00Z"),
      turnId: "turn-a",
    });

    const result = applyStreamEvent({
      tail: [optimistic],
      head: [],
      event: {
        type: "timeline",
        provider: "codex",
        turnId: "turn-b",
        item: {
          type: "user_message",
          text: "hello",
          clientMessageId: "hello-client",
          messageId: "provider-hello",
        },
      },
      timestamp: new Date("2026-08-15T10:00:01Z"),
    });

    expect(result.tail).toHaveLength(1);
    expect(result.tail[0]).toEqual(
      expect.objectContaining({
        kind: "user_message",
        clientMessageId: "hello-client",
        messageId: "provider-hello",
        turnId: "turn-b",
      }),
    );
  });

  it("clears provisional optimistic turn membership for a legacy canonical row", () => {
    const optimistic = createUserMessage({
      clientMessageId: "hello-client",
      text: "hello",
      timestamp: new Date("2026-08-15T10:00:00Z"),
      turnId: "turn-a",
    });

    const result = applyStreamEvent({
      tail: [optimistic],
      head: [],
      event: {
        type: "timeline",
        provider: "codex",
        item: {
          type: "user_message",
          text: "hello",
          clientMessageId: "hello-client",
          messageId: "provider-hello",
        },
      },
      timestamp: new Date("2026-08-15T10:00:01Z"),
    });

    expect(result.tail).toHaveLength(1);
    expect(result.tail[0]).toEqual(
      expect.objectContaining({
        kind: "user_message",
        clientMessageId: "hello-client",
        messageId: "provider-hello",
      }),
    );
    expect(result.tail[0]).not.toHaveProperty("turnId");
  });

  it("adds provider identity without replacing local presentation", () => {
    const timestamp = new Date("2026-07-26T10:00:00.000Z");
    const local = createUserMessage({
      clientMessageId: "client-1",
      text: "local text",
      timestamp,
      images: [
        {
          id: "image-1",
          mimeType: "image/png",
          storageType: "web-indexeddb",
          storageKey: "image-1.png",
          createdAt: timestamp.getTime(),
        },
      ],
      attachments: [{ type: "text", mimeType: "text/plain", text: "attachment" }],
    });
    const canonical = createUserMessage({
      id: "provider-1",
      messageId: "provider-1",
      clientMessageId: "client-1",
      text: "provider text",
      timestamp: new Date("2026-07-26T10:00:01.000Z"),
    });

    const first = upsertUserMessage([local], canonical);
    const second = upsertUserMessage(first, canonical);

    expect(first).toEqual([
      {
        ...local,
        messageId: "provider-1",
        clientMessageId: "client-1",
      },
    ]);
    expect(first[0]).toBe(second[0]);
  });

  it("keeps local presentation when a later canonical row omits provider identity", () => {
    const timestamp = new Date("2026-07-27T10:00:00.000Z");
    const local = createUserMessage({
      clientMessageId: "client-1",
      messageId: "provider-1",
      text: "local text",
      timestamp,
      images: [
        {
          id: "image-1",
          mimeType: "image/png",
          storageType: "web-indexeddb",
          storageKey: "image-1.png",
          createdAt: timestamp.getTime(),
        },
      ],
      attachments: [{ type: "text", mimeType: "text/plain", text: "local attachment" }],
    });
    const canonicalWithoutProviderIdentity = createUserMessage({
      id: "canonical-page-row",
      clientMessageId: "client-1",
      text: "provider-shaped text",
      timestamp: new Date("2026-07-27T10:00:01.000Z"),
    });

    const result = upsertUserMessage([local], canonicalWithoutProviderIdentity);

    expect(result).toEqual([local]);
  });

  it("matches a submitted message against a legacy canonical row that has no client identity", () => {
    // Daemons before v0.2.0 do not echo clientMessageId. During agent creation the
    // legacy canonical row can land before the local submission is handed off, so the
    // submitted row arrives as `incoming` and must still match by text.
    const timestamp = new Date("2026-07-27T11:00:00.000Z");
    const legacyCanonical = createUserMessage({
      id: "provider-1",
      messageId: "provider-1",
      text: "review this",
      timestamp,
    });
    const submitted = createUserMessage({
      clientMessageId: "client-1",
      text: "review this",
      timestamp: new Date("2026-07-27T11:00:01.000Z"),
      attachments: [{ type: "text", mimeType: "text/plain", text: "attachment" }],
    });

    const result = handoffCreatedAgentUserMessageToStream({
      tail: [legacyCanonical],
      head: [],
      message: submitted,
    });

    expect(result.tail).toEqual([
      {
        ...submitted,
        id: "client-1",
        messageId: "provider-1",
      },
    ]);
  });
});

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

function todoTimeline(
  items: Array<{
    id?: string;
    text: string;
    completed: boolean;
    status?: "pending" | "in_progress" | "completed";
    activeForm?: string;
  }>,
  provider: AgentProvider = "codex",
): AgentStreamEventPayload {
  return {
    type: "timeline",
    provider,
    item: {
      type: "todo",
      items,
    },
  };
}

function compactionTimeline(
  status: "loading" | "completed",
  trigger?: "auto" | "manual",
): AgentStreamEventPayload {
  return {
    type: "timeline",
    provider: "pi",
    item: {
      type: "compaction",
      status,
      ...(trigger ? { trigger } : {}),
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

  it("keeps row identities unique when an assistant message resumes after a tool", () => {
    const messageId = "msg-resumed";
    const state = hydrateStreamState([
      {
        event: assistantTimeline("Before the tool.", "codex", messageId),
        timestamp: new Date("2025-01-01T10:02:00Z"),
      },
      {
        event: canonicalToolTimeline({
          provider: "codex",
          callId: "tool-between-assistant-segments",
          name: "shell",
          status: "completed",
        }),
        timestamp: new Date("2025-01-01T10:02:01Z"),
      },
      {
        event: assistantTimeline("After the tool.", "codex", messageId),
        timestamp: new Date("2025-01-01T10:02:02Z"),
      },
    ]);

    const messages = state.filter(
      (item): item is Extract<StreamItem, { kind: "assistant_message" }> =>
        item.kind === "assistant_message",
    );
    expect(messages.map((message) => message.text)).toEqual([
      "Before the tool.",
      "After the tool.",
    ]);
    expect(messages.map((message) => message.messageId)).toEqual([messageId, messageId]);
    expect(new Set(messages.map((message) => message.id)).size).toBe(2);
  });

  it("keeps resumed live assistant rows when the turn completes", () => {
    const messageId = "msg-live-resumed";
    let tail: StreamItem[] = [];
    let head: StreamItem[] = [];

    for (const update of [
      {
        event: assistantTimeline("Before the tool.", "codex", messageId),
        timestamp: new Date("2025-01-01T10:02:00Z"),
      },
      {
        event: canonicalToolTimeline({
          provider: "codex",
          callId: "live-tool-between-assistant-segments",
          name: "shell",
          status: "completed",
        }),
        timestamp: new Date("2025-01-01T10:02:01Z"),
      },
      {
        event: assistantTimeline("After the tool.", "codex", messageId),
        timestamp: new Date("2025-01-01T10:02:02Z"),
      },
      {
        event: { type: "turn_completed" as const, provider: "codex" as const },
        timestamp: new Date("2025-01-01T10:02:03Z"),
      },
    ]) {
      const result = applyStreamEvent({
        tail,
        head,
        event: update.event,
        timestamp: update.timestamp,
      });
      tail = result.tail;
      head = result.head;
    }

    const messages = tail.filter(
      (item): item is Extract<StreamItem, { kind: "assistant_message" }> =>
        item.kind === "assistant_message",
    );
    expect(head).toEqual([]);
    expect(messages.map((message) => message.text)).toEqual([
      "Before the tool.",
      "After the tool.",
    ]);
    expect(messages.map((message) => message.messageId)).toEqual([messageId, messageId]);
    expect(new Set(messages.map((message) => message.id)).size).toBe(2);
  });

  it("keeps every promoted block when an assistant message resumes after a tool", () => {
    const messageId = "msg-promoted-resume";
    let tail: StreamItem[] = [];
    let head: StreamItem[] = [];

    for (const update of [
      {
        event: assistantTimeline("Before one.\n\nBefore two.", "codex", messageId),
        timestamp: new Date("2025-01-01T10:02:00Z"),
      },
      {
        event: canonicalToolTimeline({
          provider: "codex" as const,
          callId: "tool-between-promoted-segments",
          name: "shell",
          status: "completed" as const,
        }),
        timestamp: new Date("2025-01-01T10:02:01Z"),
      },
      {
        event: assistantTimeline("After one.\n\nAfter two.", "codex", messageId),
        timestamp: new Date("2025-01-01T10:02:02Z"),
      },
      {
        event: { type: "turn_completed" as const, provider: "codex" as const },
        timestamp: new Date("2025-01-01T10:02:03Z"),
      },
    ]) {
      const result = applyStreamEvent({
        tail,
        head,
        event: update.event,
        timestamp: update.timestamp,
      });
      tail = result.tail;
      head = result.head;
    }

    const messages = tail.filter(
      (item): item is Extract<StreamItem, { kind: "assistant_message" }> =>
        item.kind === "assistant_message",
    );
    expect(messages.map((message) => message.text)).toEqual([
      "Before one.",
      "Before two.",
      "After one.",
      "After two.",
    ]);
    expect(new Set(messages.map((message) => message.id)).size).toBe(messages.length);
  });

  it("keeps the timeline position on every promoted assistant block", () => {
    const timelineCursor = { epoch: "epoch-1", seq: 42 };
    const result = applyStreamEvent({
      tail: [],
      head: [],
      event: assistantTimeline("First paragraph.\n\nSecond paragraph.", undefined, "message-1"),
      timestamp: new Date("2025-01-01T10:02:00Z"),
      timelineCursor,
    });

    const messages = [...result.tail, ...result.head].filter(
      (item): item is Extract<StreamItem, { kind: "assistant_message" }> =>
        item.kind === "assistant_message",
    );
    expect(messages.map((message) => message.text)).toEqual([
      "First paragraph.",
      "Second paragraph.",
    ]);
    expect(messages.map((message) => message.timelineCursor)).toEqual([
      timelineCursor,
      timelineCursor,
    ]);
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
    assert.strictEqual(display.displayName, "Exec command");
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
    assert.deepStrictEqual(todos.activity, { type: "created", count: 2 });
  });

  it("turns task snapshots into semantic timeline activity", () => {
    const state = hydrateStreamState([
      {
        event: todoTimeline([
          { id: "a", text: "Inspect provider", completed: false, status: "pending" },
          { id: "b", text: "Ship fix", completed: false, status: "pending" },
        ]),
        timestamp: new Date("2025-01-01T10:50:00Z"),
      },
      {
        event: todoTimeline([
          { id: "a", text: "Inspect provider", completed: false, status: "in_progress" },
          { id: "b", text: "Ship fix", completed: false, status: "pending" },
        ]),
        timestamp: new Date("2025-01-01T10:50:01Z"),
      },
      {
        event: todoTimeline([
          { id: "a", text: "Inspect provider", completed: true, status: "completed" },
          { id: "b", text: "Ship fix", completed: false, status: "in_progress" },
        ]),
        timestamp: new Date("2025-01-01T10:50:02Z"),
      },
      {
        event: todoTimeline([
          { id: "a", text: "Inspect provider", completed: true, status: "completed" },
          { id: "b", text: "Ship fix", completed: true, status: "completed" },
        ]),
        timestamp: new Date("2025-01-01T10:50:03Z"),
      },
    ]);

    expect(state.flatMap((item) => (item.kind === "todo_list" ? [item.activity] : []))).toEqual([
      { type: "created", count: 2 },
      { type: "started", task: "Inspect provider" },
      { type: "completed", task: "Inspect provider" },
      { type: "started", task: "Ship fix" },
      { type: "completed", task: "Ship fix" },
    ]);
  });

  it("reports new work after completed tasks without reopening anything", () => {
    const state = hydrateStreamState([
      {
        event: todoTimeline([
          { id: "0", text: "Finish old work", completed: true, status: "completed" },
          { id: "1", text: "Verify old work", completed: true, status: "completed" },
        ]),
        timestamp: new Date("2025-01-01T10:50:00Z"),
      },
      {
        event: todoTimeline([
          { id: "0", text: "Investigate unrelated bug", completed: false, status: "in_progress" },
          { id: "1", text: "Write unrelated test", completed: false, status: "pending" },
        ]),
        timestamp: new Date("2025-01-01T10:51:00Z"),
      },
    ]);

    expect(state.flatMap((item) => (item.kind === "todo_list" ? [item.activity] : []))).toEqual([
      { type: "created", count: 2 },
      { type: "started", task: "Investigate unrelated bug" },
    ]);
  });

  it("groups consecutive initial Claude TaskCreate snapshots", () => {
    const state = hydrateStreamState([
      {
        event: todoTimeline(
          [{ id: "a", text: "Inspect provider", completed: false, status: "pending" }],
          "claude",
        ),
        timestamp: new Date("2025-01-01T10:50:00Z"),
      },
      {
        event: todoTimeline(
          [
            { id: "a", text: "Inspect provider", completed: false, status: "pending" },
            { id: "b", text: "Ship fix", completed: false, status: "pending" },
          ],
          "claude",
        ),
        timestamp: new Date("2025-01-01T10:50:01Z"),
      },
    ]);

    expect(state.filter((item) => item.kind === "todo_list")).toEqual([
      expect.objectContaining({
        activity: { type: "created", count: 2 },
        items: expect.arrayContaining([
          expect.objectContaining({ text: "Inspect provider" }),
          expect.objectContaining({ text: "Ship fix" }),
        ]),
      }),
    ]);
  });

  it("terminalizes the loading compaction before a completed turn", () => {
    const state = hydrateStreamState([
      {
        event: compactionTimeline("loading", "auto"),
        timestamp: new Date("2025-01-01T10:50:00Z"),
      },
      {
        event: compactionTimeline("completed"),
        timestamp: new Date("2025-01-01T10:50:01Z"),
      },
      {
        event: { type: "turn_completed", provider: "codex" },
        timestamp: new Date("2025-01-01T10:50:02Z"),
      },
    ]);

    const compactions = state.filter(
      (item): item is Extract<StreamItem, { kind: "compaction" }> => item.kind === "compaction",
    );

    assert.strictEqual(compactions.length, 1);
    assert.strictEqual(compactions[0].status, "completed");
    assert.strictEqual(compactions[0].trigger, "auto");
    assert.strictEqual(
      state.some((item) => item.kind === "compaction" && item.status === "loading"),
      false,
    );
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

  it.each(["TaskCreate", "TaskUpdate", "TaskList"])(
    "suppresses Claude %s bookkeeping tool calls",
    (name) => {
      const state = hydrateStreamState([
        {
          event: canonicalToolTimeline({
            provider: "claude",
            callId: name,
            name,
            status: "completed",
            input: { taskId: "1", status: "completed" },
          }),
          timestamp: new Date("2025-01-01T11:00:00Z"),
        },
      ]);

      expect(state.filter(isAgentToolCallItem)).toEqual([]);
    },
  );

  it("preserves submitted user message images when authoritative user message arrives", () => {
    const messageId = "msg-user-images";
    const submittedTimestamp = new Date("2025-01-01T11:10:00Z");
    const submittedImages = [
      {
        id: "att-submitted",
        mimeType: "image/jpeg",
        storageType: "native-file" as const,
        storageKey: "/tmp/submitted.jpg",
        createdAt: Date.now(),
      },
    ];
    const initialState: StreamItem[] = [
      {
        kind: "user_message",
        id: messageId,
        clientMessageId: messageId,
        text: "Analyze this image",
        timestamp: submittedTimestamp,
        images: submittedImages,
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
    assert.deepStrictEqual(message.images, submittedImages);
    assert.strictEqual(message.text, "Analyze this image");
    assert.strictEqual(message.timestamp.getTime(), submittedTimestamp.getTime());
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

  it("keeps live submitted assistant merge behavior", () => {
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
    "replaces a submitted user message when a live %s provider-owned id echo arrives without text matching",
    (provider) => {
      const submittedTimestamp = new Date("2025-01-01T15:02:00Z");
      const serverTimestamp = new Date("2025-01-01T15:02:01Z");
      const submitted: StreamItem = {
        kind: "user_message",
        id: "msg_submitted",
        clientMessageId: "msg_submitted",
        text: "same user text",
        timestamp: submittedTimestamp,
        images: [
          {
            id: "image-1",
            mimeType: "image/png",
            storageType: "web-indexeddb",
            storageKey: "image-1",
            createdAt: submittedTimestamp.getTime(),
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
        [submitted],
        {
          type: "timeline",
          provider,
          item: {
            type: "user_message",
            text: "server-owned rendered text",
            messageId: "provider-owned-id",
            clientMessageId: "msg_submitted",
          },
        },
        serverTimestamp,
        { source: "live" },
      );

      const userMessages = state.filter((item) => item.kind === "user_message");
      assert.strictEqual(userMessages.length, 1);
      const userMessage = userMessages[0];
      invariant(userMessage?.kind === "user_message");
      assert.strictEqual(userMessage.id, "msg_submitted");
      assert.strictEqual(userMessage.messageId, "provider-owned-id");
      assert.strictEqual(userMessage.text, submitted.text);
      assert.strictEqual(userMessage.timestamp.getTime(), submitted.timestamp.getTime());
      assert.deepStrictEqual(userMessage.images, submitted.images);
      assert.deepStrictEqual(userMessage.attachments, submitted.attachments);
    },
  );

  it("replaces one submitted plain-text user message with the next live server user message", () => {
    const submittedTimestamp = new Date("2025-01-01T15:03:00Z");
    const serverTimestamp = new Date("2025-01-01T15:03:01Z");
    const submitted: StreamItem = {
      kind: "user_message",
      id: "msg_submitted",
      clientMessageId: "msg_submitted",
      text: "typed plain text",
      timestamp: submittedTimestamp,
    };

    const state = reduceStreamUpdate(
      [submitted],
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
    assert.strictEqual(userMessage.id, "msg_submitted");
    assert.strictEqual(userMessage.messageId, "msg_opencode_provider_owned");
    assert.strictEqual(userMessage.text, "typed plain text");
    assert.strictEqual(userMessage.timestamp.getTime(), submittedTimestamp.getTime());
  });

  it("replaces a submitted image user message with the next canonical server user message", () => {
    const submittedTimestamp = new Date("2025-01-01T15:03:10Z");
    const image = {
      id: "image-canonical",
      mimeType: "image/png",
      storageType: "web-indexeddb" as const,
      storageKey: "image-canonical",
      createdAt: submittedTimestamp.getTime(),
    };
    const attachment = {
      type: "text" as const,
      mimeType: "text/plain" as const,
      text: "context",
      title: "context.txt",
    };
    const submitted = createUserMessage({
      clientMessageId: "msg_submitted_canonical",
      text: "Analyze this",
      timestamp: submittedTimestamp,
      images: [image],
      attachments: [attachment],
    });

    const state = reduceStreamUpdate(
      [submitted],
      {
        type: "timeline",
        provider: "claude",
        item: {
          type: "user_message",
          text: "server-rendered attachment text",
          messageId: "provider-owned-canonical",
          clientMessageId: submitted.id,
        },
      },
      new Date("2025-01-01T15:03:11Z"),
      {
        source: "canonical",
        timelineCursor: { epoch: "epoch-1", seq: 42 },
      },
    );

    const userMessages = state.filter((item) => item.kind === "user_message");
    assert.strictEqual(userMessages.length, 1);
    const userMessage = userMessages[0];
    invariant(userMessage?.kind === "user_message");
    assert.strictEqual(userMessage.id, "msg_submitted_canonical");
    assert.strictEqual(userMessage.messageId, "provider-owned-canonical");
    assert.strictEqual(userMessage.text, "Analyze this");
    assert.strictEqual(userMessage.timestamp.getTime(), submittedTimestamp.getTime());
    assert.deepStrictEqual(userMessage.timelineCursor, { epoch: "epoch-1", seq: 42 });
    assert.deepStrictEqual(userMessage.images, [image]);
    assert.deepStrictEqual(userMessage.attachments, [attachment]);
  });

  it("places submitted user messages through the identity producer", () => {
    const submitted = createUserMessage({
      clientMessageId: "msg_append_once",
      text: "append once",
      timestamp: new Date("2025-01-01T15:03:20Z"),
    });
    const headItem: StreamItem = {
      kind: "assistant_message",
      id: "assistant-head",
      text: "streaming",
      timestamp: new Date("2025-01-01T15:03:19Z"),
    };

    const first = upsertUserMessageAcrossStream({
      tail: [],
      head: [headItem],
      message: submitted,
      insert: "head",
      presentation: "existing",
    });
    const second = upsertUserMessageAcrossStream({
      tail: first.tail,
      head: first.head,
      message: submitted,
      insert: "head",
      presentation: "existing",
    });
    assert.deepStrictEqual(first.tail, []);
    assert.deepStrictEqual(first.head, [headItem, submitted]);
    assert.strictEqual(second.changedHead, false);
    assert.strictEqual(second.head, first.head);
  });

  it("hands rich submitted content to its create message without overwriting an earlier user row", () => {
    const timestamp = new Date("2025-01-01T15:03:20Z");
    const submitted = createUserMessage({
      clientMessageId: "client-user",
      text: "",
      timestamp,
      images: [
        {
          id: "image-1",
          mimeType: "image/png",
          storageType: "web-indexeddb",
          storageKey: "image-1",
          createdAt: timestamp.getTime(),
        },
      ],
      attachments: [
        {
          type: "text",
          mimeType: "text/plain",
          text: "Previous conversation",
          title: "Chat history",
          contextKind: "chat_history",
        },
      ],
    });
    const precedingProviderRow: StreamItem = {
      kind: "user_message",
      id: "provider-system-user",
      messageId: "provider-system-user",
      text: "provider setup prompt",
      timestamp: new Date("2025-01-01T15:03:20.500Z"),
    };
    const canonical: StreamItem = {
      kind: "user_message",
      id: "provider-user",
      messageId: "provider-user",
      clientMessageId: "client-user",
      text: "server-rendered attachment text",
      timestamp: new Date("2025-01-01T15:03:21Z"),
    };

    const handedOff = handoffCreatedAgentUserMessageToStream({
      tail: [precedingProviderRow, canonical],
      head: [],
      message: submitted,
    });
    const repeated = handoffCreatedAgentUserMessageToStream({
      tail: handedOff.tail,
      head: handedOff.head,
      message: submitted,
    });

    assert.deepStrictEqual(handedOff.tail, [
      precedingProviderRow,
      {
        kind: "user_message",
        id: "client-user",
        clientMessageId: "client-user",
        messageId: "provider-user",
        text: submitted.text,
        timestamp: submitted.timestamp,
        images: submitted.images,
        attachments: submitted.attachments,
      },
    ]);
    assert.deepStrictEqual(handedOff.head, []);
    assert.deepStrictEqual(repeated.tail, handedOff.tail);
    assert.deepStrictEqual(repeated.head, handedOff.head);

    const afterNextUser = reduceStreamUpdate(
      handedOff.tail,
      {
        type: "timeline",
        provider: "claude",
        item: {
          type: "user_message",
          text: "Next prompt",
          messageId: "provider-next-user",
        },
      },
      new Date("2025-01-01T15:04:00Z"),
    );
    assert.deepStrictEqual(
      afterNextUser.filter((item) => item.kind === "user_message").map((item) => item.id),
      ["provider-system-user", "client-user", "provider-next-user"],
    );
  });

  it("flushes an interrupted head when its submitted prompt becomes canonical", () => {
    const submitted: StreamItem = {
      kind: "user_message",
      id: "msg_head_submitted",
      clientMessageId: "msg_head_submitted",
      text: "plain text in head",
      timestamp: new Date("2025-01-01T15:03:02Z"),
    };

    const result = applyStreamEvent({
      tail: [],
      head: [submitted],
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

    assert.deepStrictEqual(result.head, []);
    const userMessages = result.tail.filter((item) => item.kind === "user_message");
    assert.strictEqual(userMessages.length, 1);
    assert.strictEqual(userMessages[0]?.id, "msg_head_submitted");
    assert.strictEqual(userMessages[0]?.messageId, "provider-owned-head");
  });

  it("keeps a replacement assistant separate after an interrupted prompt is reconciled", () => {
    const interruptedAssistant: StreamItem = {
      kind: "assistant_message",
      id: "interrupted",
      text: "old answer",
      timestamp: new Date("2025-01-01T15:03:01Z"),
    };
    const submitted = createUserMessage({
      clientMessageId: "msg_interrupt",
      text: "replacement prompt",
      timestamp: new Date("2025-01-01T15:03:02Z"),
    });
    const reconciled = applyStreamEvent({
      tail: [],
      head: [interruptedAssistant, submitted],
      event: {
        type: "timeline",
        provider: "opencode",
        item: {
          type: "user_message",
          text: submitted.text,
          messageId: "provider-prompt",
          clientMessageId: submitted.clientMessageId,
        },
      },
      timestamp: new Date("2025-01-01T15:03:03Z"),
    });
    const replacement = applyStreamEvent({
      tail: reconciled.tail,
      head: reconciled.head,
      event: {
        type: "timeline",
        provider: "opencode",
        item: { type: "assistant_message", text: "new answer" },
      },
      timestamp: new Date("2025-01-01T15:03:04Z"),
    });

    expect(replacement.tail.map((item) => item.kind)).toEqual([
      "assistant_message",
      "user_message",
    ]);
    expect(replacement.head).toEqual([
      expect.objectContaining({ kind: "assistant_message", text: "new answer" }),
    ]);
  });

  it("replaces multiple submitted user messages in FIFO order", () => {
    const submittedTimestamp = new Date("2025-01-01T15:04:00Z");
    const serverTimestamp = new Date("2025-01-01T15:04:01Z");
    const firstSubmitted: StreamItem = {
      kind: "user_message",
      id: "msg_submitted_1",
      clientMessageId: "msg_submitted_1",
      text: "first typed text",
      timestamp: submittedTimestamp,
    };
    const secondSubmitted: StreamItem = {
      kind: "user_message",
      id: "msg_submitted_2",
      clientMessageId: "msg_submitted_2",
      text: "second typed text",
      timestamp: new Date("2025-01-01T15:04:00.500Z"),
    };

    const afterFirstEcho = reduceStreamUpdate(
      [firstSubmitted, secondSubmitted],
      {
        type: "timeline",
        provider: "opencode",
        item: {
          type: "user_message",
          text: "first server text",
          messageId: "provider-owned-first",
          clientMessageId: "msg_submitted_1",
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
          clientMessageId: "msg_submitted_2",
        },
      },
      new Date("2025-01-01T15:04:02Z"),
      { source: "live" },
    );

    const userMessages = state.filter((item) => item.kind === "user_message");
    assert.strictEqual(userMessages.length, 2);
    assert.deepStrictEqual(
      userMessages.map((item) => [item.id, item.text, item.messageId]),
      [
        ["msg_submitted_1", "first typed text", "provider-owned-first"],
        ["msg_submitted_2", "second typed text", "provider-owned-second"],
      ],
    );
  });

  it("does not shift later prompts when an earlier submitted prompt has no canonical echo", () => {
    const staleTimestamp = new Date("2025-01-01T15:04:00Z");
    const submittedTimestamp = new Date("2025-01-01T15:04:01Z");
    const stalePrompt: StreamItem = {
      kind: "user_message",
      id: "msg_stale",
      clientMessageId: "msg_stale",
      text: "first prompt without an echo",
      timestamp: staleTimestamp,
    };
    const submittedPrompt: StreamItem = {
      kind: "user_message",
      id: "msg_submitted",
      clientMessageId: "msg_submitted",
      text: "later submitted prompt",
      timestamp: submittedTimestamp,
    };

    const state = reduceStreamUpdate(
      [stalePrompt, submittedPrompt],
      {
        type: "timeline",
        provider: "codex",
        item: {
          type: "user_message",
          text: "canonical rendered prompt",
          messageId: "provider-owned-submitted",
          clientMessageId: submittedPrompt.id,
        },
      },
      new Date("2025-01-01T15:04:02Z"),
      { source: "live" },
    );

    assert.deepStrictEqual(state, [
      stalePrompt,
      {
        kind: "user_message",
        id: "msg_submitted",
        clientMessageId: submittedPrompt.id,
        messageId: "provider-owned-submitted",
        text: submittedPrompt.text,
        timestamp: submittedPrompt.timestamp,
      },
    ]);
  });

  it("appends a live server user message when no submitted user message is pending", () => {
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
  });

  it("appends a server user message after a rewound local row was removed", () => {
    const state = reduceStreamUpdate(
      [],
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
