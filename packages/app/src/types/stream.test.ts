import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  hydrateStreamState,
  type AgentToolCallItem,
  type StreamItem,
  isAgentToolCallItem,
} from "./stream";
import type { AgentProvider, ToolCallDetail } from "@server/server/agent/agent-sdk-types";
import type { AgentStreamEventPayload } from "@server/shared/messages";
import { buildToolCallDisplayModel } from "@/utils/tool-call-display";

type CanonicalToolStatus = "running" | "completed" | "failed" | "canceled";

function assistantTimeline(text: string, provider: AgentProvider = "claude"): AgentStreamEventPayload {
  return {
    type: "timeline",
    provider,
    item: { type: "assistant_message", text },
  };
}

function reasoningTimeline(text: string, provider: AgentProvider = "claude"): AgentStreamEventPayload {
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
  input?: unknown | null;
  output?: unknown | null;
  error?: unknown;
  metadata?: Record<string, unknown>;
  detail?: ToolCallDetail;
}): AgentStreamEventPayload {
  const baseItem = {
    type: "tool_call" as const,
    callId: params.callId,
    name: params.name,
    status: params.status,
    input: params.input ?? null,
    output: params.output ?? null,
    metadata: params.metadata,
    ...(params.detail ? { detail: params.detail } : {}),
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
      isAgentToolCallItem(item) && item.payload.data.callId === callId
  );
}

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

    assert.strictEqual(JSON.stringify(first), JSON.stringify(second));
    const assistantMessage = first.find((item) => item.kind === "assistant_message");
    assert.strictEqual(assistantMessage?.text, "Hello world");
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
    assert.deepStrictEqual(tools[0].payload.data.input, { command: "pwd" });
    assert.deepStrictEqual(tools[0].payload.data.result, {
      output: "/tmp/repo\n",
      exitCode: 0,
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
      detail: tool.payload.data.detail,
      cwd: "/tmp/repo",
    }).summary;
    assert.strictEqual(summary, "README.md");
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
    assert.deepStrictEqual(tool.payload.data.input, { path: "README.md" });
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

    const todos = state.find((item): item is Extract<StreamItem, { kind: "todo_list" }> => item.kind === "todo_list");

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
    const todos = state.find((item): item is Extract<StreamItem, { kind: "todo_list" }> => item.kind === "todo_list");

    assert.strictEqual(tools.length, 0);
    assert.ok(todos);
    assert.strictEqual(todos.items[0]?.text, "Task 1");
  });
});
