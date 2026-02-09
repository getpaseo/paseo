import { describe, expect, it } from "vitest";
import type { AgentStreamEventPayload } from "@server/shared/messages";
import type { StreamItem, ThoughtItem } from "@/types/stream";
import {
  applyStreamEvent,
  applyStreamEventWithBuffer,
  type StreamingBufferEntry,
} from "@/types/stream";

const baseTimestamp = new Date(0);

const assistantChunk = (text: string): AgentStreamEventPayload => ({
  type: "timeline",
  provider: "codex",
  item: {
    type: "assistant_message",
    text,
  },
});

const toolCallEvent = (): AgentStreamEventPayload => ({
  type: "timeline",
  provider: "codex",
  item: {
    type: "tool_call",
    callId: "buffer-tool-call",
    name: "run",
    status: "running",
    detail: {
      type: "unknown",
      rawInput: { command: "echo hi" },
      rawOutput: null,
    },
    error: null,
  },
});

const completionEvent = (): AgentStreamEventPayload => ({
  type: "turn_completed",
  provider: "codex",
});

const permissionEvent = (): AgentStreamEventPayload => ({
  type: "permission_requested",
  provider: "codex",
  request: {
    id: "perm-1",
    provider: "codex",
    name: "test",
    kind: "tool",
  },
});

const reasoningChunk = (text: string): AgentStreamEventPayload => ({
  type: "timeline",
  provider: "claude",
  item: {
    type: "reasoning",
    text,
  },
});

describe("applyStreamEventWithBuffer", () => {
  it("buffers assistant chunks without changing stream", () => {
    const stream: StreamItem[] = [];
    const result = applyStreamEventWithBuffer({
      state: stream,
      buffer: null,
      event: assistantChunk("Hel"),
      timestamp: baseTimestamp,
    });

    expect(result.stream).toBe(stream);
    expect(result.changedStream).toBe(false);
    expect(result.buffer?.text).toBe("Hel");
  });

  it("appends assistant chunks to the buffer", () => {
    const stream: StreamItem[] = [];
    const initial = applyStreamEventWithBuffer({
      state: stream,
      buffer: null,
      event: assistantChunk("Hel"),
      timestamp: baseTimestamp,
    });
    const next = applyStreamEventWithBuffer({
      state: stream,
      buffer: initial.buffer,
      event: assistantChunk("lo"),
      timestamp: baseTimestamp,
    });

    expect(next.buffer?.text).toBe("Hello");
    expect(next.changedStream).toBe(false);
  });

  it("commits buffered message on completion", () => {
    const stream: StreamItem[] = [];
    const buffered = applyStreamEventWithBuffer({
      state: stream,
      buffer: null,
      event: assistantChunk("Hello"),
      timestamp: baseTimestamp,
    });
    const result = applyStreamEventWithBuffer({
      state: stream,
      buffer: buffered.buffer,
      event: completionEvent(),
      timestamp: baseTimestamp,
    });

    expect(result.buffer).toBe(null);
    expect(result.stream).toHaveLength(1);
    expect(result.stream[0].kind).toBe("assistant_message");
    expect((result.stream[0] as { text: string }).text).toBe("Hello");
  });

  it("commits buffer before non-assistant timeline items", () => {
    const stream: StreamItem[] = [];
    const buffered = applyStreamEventWithBuffer({
      state: stream,
      buffer: null,
      event: assistantChunk("Hello"),
      timestamp: baseTimestamp,
    });
    const result = applyStreamEventWithBuffer({
      state: stream,
      buffer: buffered.buffer,
      event: toolCallEvent(),
      timestamp: baseTimestamp,
    });

    expect(result.buffer).toBe(null);
    expect(result.stream).toHaveLength(2);
    expect(result.stream[0].kind).toBe("assistant_message");
    expect(result.stream[1].kind).toBe("tool_call");
  });

  it("keeps stream reference for no-op events", () => {
    const stream: StreamItem[] = [];
    const result = applyStreamEventWithBuffer({
      state: stream,
      buffer: null,
      event: permissionEvent(),
      timestamp: baseTimestamp,
    });

    expect(result.stream).toBe(stream);
    expect(result.changedStream).toBe(false);
  });

  it("avoids double-committing an already flushed buffer", () => {
    const stream: StreamItem[] = [
      {
        kind: "assistant_message",
        id: "dup",
        text: "Hello",
        timestamp: baseTimestamp,
      },
    ];
    const buffer: StreamingBufferEntry = {
      id: "dup",
      text: "Hello",
      timestamp: baseTimestamp,
    };
    const result = applyStreamEventWithBuffer({
      state: stream,
      buffer,
      event: completionEvent(),
      timestamp: baseTimestamp,
    });

    expect(result.stream).toBe(stream);
    expect(result.buffer).toBe(null);
  });
});

describe("applyStreamEvent (head/tail model)", () => {
  it("buffers reasoning chunks in head", () => {
    const result = applyStreamEvent({
      tail: [],
      head: [],
      event: reasoningChunk("Let me think..."),
      timestamp: baseTimestamp,
    });

    expect(result.tail).toHaveLength(0);
    expect(result.head).toHaveLength(1);
    expect(result.head[0].kind).toBe("thought");
    expect((result.head[0] as ThoughtItem).text).toBe("Let me think...");
    expect((result.head[0] as ThoughtItem).status).toBe("loading");
  });

  it("accumulates reasoning chunks in head", () => {
    let result = applyStreamEvent({
      tail: [],
      head: [],
      event: reasoningChunk("Let me "),
      timestamp: baseTimestamp,
    });
    result = applyStreamEvent({
      tail: result.tail,
      head: result.head,
      event: reasoningChunk("think..."),
      timestamp: baseTimestamp,
    });

    expect(result.tail).toHaveLength(0);
    expect(result.head).toHaveLength(1);
    expect((result.head[0] as ThoughtItem).text).toBe("Let me think...");
  });

  it("flushes reasoning to tail when tool call arrives", () => {
    let result = applyStreamEvent({
      tail: [],
      head: [],
      event: reasoningChunk("Thinking..."),
      timestamp: baseTimestamp,
    });
    result = applyStreamEvent({
      tail: result.tail,
      head: result.head,
      event: toolCallEvent(),
      timestamp: baseTimestamp,
    });

    expect(result.head).toHaveLength(0);
    expect(result.tail).toHaveLength(2);
    expect(result.tail[0].kind).toBe("thought");
    expect((result.tail[0] as ThoughtItem).status).toBe("ready");
    expect(result.tail[1].kind).toBe("tool_call");
  });

  it("flushes head on turn completion", () => {
    let result = applyStreamEvent({
      tail: [],
      head: [],
      event: assistantChunk("Hello"),
      timestamp: baseTimestamp,
    });
    result = applyStreamEvent({
      tail: result.tail,
      head: result.head,
      event: completionEvent(),
      timestamp: baseTimestamp,
    });

    expect(result.head).toHaveLength(0);
    expect(result.tail).toHaveLength(1);
    expect(result.tail[0].kind).toBe("assistant_message");
  });

  it("flushes reasoning when assistant message starts", () => {
    let result = applyStreamEvent({
      tail: [],
      head: [],
      event: reasoningChunk("Thinking..."),
      timestamp: baseTimestamp,
    });
    result = applyStreamEvent({
      tail: result.tail,
      head: result.head,
      event: assistantChunk("Here's my answer"),
      timestamp: baseTimestamp,
    });

    expect(result.tail).toHaveLength(1);
    expect(result.tail[0].kind).toBe("thought");
    expect((result.tail[0] as ThoughtItem).status).toBe("ready");
    expect(result.head).toHaveLength(1);
    expect(result.head[0].kind).toBe("assistant_message");
  });
});
