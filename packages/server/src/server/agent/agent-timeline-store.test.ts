import { describe, expect, it } from "vitest";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";

describe("InMemoryAgentTimelineStore", () => {
  it("indexes tool lifecycle bounds by call id", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent-1", {
      epoch: "epoch-1",
      nextSeq: 8,
      rows: [
        {
          seq: 5,
          timestamp: "2026-01-01T00:00:00.000Z",
          turnId: "turn-a",
          item: {
            type: "tool_call",
            callId: "call-1",
            name: "shell",
            status: "running",
            error: null,
            detail: { type: "shell", command: "pwd", output: null },
          },
        },
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          turnId: "turn-b",
          item: {
            type: "tool_call",
            callId: "call-1",
            name: "shell",
            status: "running",
            error: null,
            detail: { type: "shell", command: "pwd", output: null },
          },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          turnId: "turn-a",
          item: {
            type: "tool_call",
            callId: "call-1",
            name: "shell",
            status: "completed",
            error: null,
            detail: { type: "shell", command: "pwd", output: "/workspace" },
          },
        },
      ],
    });

    const appended = store.append(
      "agent-1",
      {
        type: "tool_call",
        callId: "call-2",
        name: "shell",
        status: "running",
        error: null,
        detail: { type: "shell", command: "ls", output: null },
      },
      { turnId: "turn-a" },
    );

    expect(store.getToolCallSeqBounds("agent-1", "call-1")).toEqual({
      minSeq: 5,
      maxSeq: 7,
    });
    expect(appended.seq).toBe(8);
    expect(store.getToolCallSeqBounds("agent-1", "call-2")).toEqual({
      minSeq: 8,
      maxSeq: 8,
    });
  });

  it("clamps an overshooting before cursor into the bounded tail window", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent-1", {
      epoch: "epoch-1",
      nextSeq: 8,
      rows: [
        {
          seq: 5,
          timestamp: "2026-01-01T00:00:00.000Z",
          item: { type: "assistant_message", text: "five" },
        },
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven" },
        },
      ],
    });

    const result = store.fetch("agent-1", {
      direction: "before",
      cursor: { epoch: "epoch-1", seq: 100 },
      limit: 2,
    });

    expect(result).toEqual({
      epoch: "epoch-1",
      direction: "before",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 5, maxSeq: 7, nextSeq: 8 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven" },
        },
      ],
    });
  });

  it("returns a bounded reset window when an after cursor is behind retained history", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent-1", {
      epoch: "epoch-1",
      nextSeq: 8,
      rows: [
        {
          seq: 5,
          timestamp: "2026-01-01T00:00:00.000Z",
          item: { type: "assistant_message", text: "five" },
        },
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven" },
        },
      ],
    });

    const result = store.fetch("agent-1", {
      direction: "after",
      cursor: { epoch: "epoch-1", seq: 1 },
      limit: 1,
    });

    expect(result).toEqual({
      epoch: "epoch-1",
      direction: "after",
      reset: true,
      staleCursor: false,
      gap: true,
      window: { minSeq: 5, maxSeq: 7, nextSeq: 8 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven" },
        },
      ],
    });
  });
});
