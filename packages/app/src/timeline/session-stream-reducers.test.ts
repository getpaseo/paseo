import { describe, expect, it } from "vitest";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import {
  buildOptimisticUserMessage,
  hydrateStreamState,
  type AgentToolCallItem,
  type StreamItem,
} from "@/types/stream";
import {
  createAgentStreamReducerQueue,
  processTimelineResponse,
  processAgentStreamEvent,
  processAgentStreamEvents,
  type ProcessTimelineResponseInput,
  type ProcessAgentStreamEventInput,
  type AgentStreamReducerEvent,
  type TimelineCursor,
} from "./session-stream-reducers";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTimelineEntry(
  seq: number,
  text: string,
  type: string = "assistant_message",
  seqEnd = seq,
) {
  return {
    seqStart: seq,
    seqEnd,
    provider: "claude",
    item: { type, text },
    timestamp: new Date(1000 + seq).toISOString(),
  };
}

function makeToolCallTimelineEntry(
  seq: number,
  callId: string,
  status: "running" | "completed",
  detail: Record<string, unknown>,
) {
  return {
    seqStart: seq,
    seqEnd: seq,
    provider: "claude",
    item: {
      type: "tool_call",
      callId,
      name: "Read",
      status,
      detail,
      error: null,
    },
    timestamp: new Date(1000 + seq).toISOString(),
  };
}

function makeTimelineEvent(
  text: string,
  type: string = "assistant_message",
): AgentStreamEventPayload {
  return {
    type: "timeline",
    provider: "claude",
    item: { type, text },
  } as AgentStreamEventPayload;
}

function makeAssistantTimelineEvent(text: string, messageId?: string): AgentStreamEventPayload {
  return {
    type: "timeline",
    provider: "claude",
    item: { type: "assistant_message", text, ...(messageId ? { messageId } : {}) },
  } as AgentStreamEventPayload;
}

function makeToolCallTimelineEvent(callId: string): AgentStreamEventPayload {
  return {
    type: "timeline",
    provider: "claude",
    item: {
      type: "tool_call",
      callId,
      name: "Read",
      status: "running",
      detail: {
        type: "read",
        filePath: "/tmp/example.ts",
      },
      error: null,
    },
  } as AgentStreamEventPayload;
}

function makeStreamReducerEvent(
  event: AgentStreamEventPayload,
  seq: number,
): AgentStreamReducerEvent {
  return {
    event,
    seq,
    epoch: "epoch-1",
    timestamp: new Date(1000 + seq),
  };
}

function makeAssistantItem(text: string, id = `assistant-${text.length}`): StreamItem {
  return {
    kind: "assistant_message",
    id,
    text,
    timestamp: new Date(1000),
  };
}

function makeOptimisticUserMessage(
  text: string,
  id = `optimistic-${text.length}`,
): Extract<StreamItem, { kind: "user_message" }> {
  return buildOptimisticUserMessage({
    id,
    text,
    timestamp: new Date(1000),
  });
}

function getAssistantTexts(items: StreamItem[]): string[] {
  return items
    .filter((item): item is Extract<StreamItem, { kind: "assistant_message" }> => {
      return item.kind === "assistant_message";
    })
    .map((item) => item.text);
}

function getUserTexts(items: StreamItem[]): string[] {
  return items
    .filter((item): item is Extract<StreamItem, { kind: "user_message" }> => {
      return item.kind === "user_message";
    })
    .map((item) => item.text);
}

function getAgentToolCalls(items: StreamItem[]) {
  return items.filter(
    (item): item is AgentToolCallItem =>
      item.kind === "tool_call" && item.payload.source === "agent",
  );
}

const baseTimelineInput: ProcessTimelineResponseInput = {
  payload: {
    agentId: "agent-1",
    direction: "after",
    reset: false,
    epoch: "epoch-1",
    startCursor: null,
    endCursor: null,
    entries: [],
    error: null,
    hasNewer: false,
    hasOlder: false,
  },
  currentTail: [],
  currentHead: [],
  currentCursor: undefined,
  isInitializing: false,
  hasActiveInitDeferred: false,
  initRequestDirection: "tail",
};

const baseStreamInput: ProcessAgentStreamEventInput = {
  event: makeTimelineEvent("hello"),
  seq: undefined,
  epoch: undefined,
  currentTail: [],
  currentHead: [],
  currentCursor: undefined,
  currentAgent: null,
  timestamp: new Date(2000),
};

// ---------------------------------------------------------------------------
// processTimelineResponse
// ---------------------------------------------------------------------------

describe("processTimelineResponse", () => {
  it("returns error path when payload.error is set", () => {
    const result = processTimelineResponse({
      ...baseTimelineInput,
      isInitializing: true,
      hasActiveInitDeferred: true,
      payload: {
        ...baseTimelineInput.payload,
        error: "something broke",
      },
    });

    expect(result.error).toBe("something broke");
    expect(result.initResolution).toBe("reject");
    expect(result.clearInitializing).toBe(true);
    expect(result.tail).toBe(baseTimelineInput.currentTail);
    expect(result.head).toBe(baseTimelineInput.currentHead);
    expect(result.cursorChanged).toBe(false);
    expect(result.sideEffects).toEqual([]);
  });

  it("returns error with no init resolution when no deferred exists", () => {
    const result = processTimelineResponse({
      ...baseTimelineInput,
      isInitializing: true,
      hasActiveInitDeferred: false,
      payload: {
        ...baseTimelineInput.payload,
        error: "timeout",
      },
    });

    expect(result.error).toBe("timeout");
    expect(result.initResolution).toBe(null);
    expect(result.clearInitializing).toBe(true);
  });

  it("replaces tail and clears head when reset=true", () => {
    const existingTail: StreamItem[] = [
      {
        kind: "user_message",
        id: "old",
        text: "old message",
        timestamp: new Date(500),
      },
    ];
    const existingHead: StreamItem[] = [
      {
        kind: "assistant_message",
        id: "head-1",
        text: "streaming",
        timestamp: new Date(600),
      },
    ];

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: existingTail,
      currentHead: existingHead,
      payload: {
        ...baseTimelineInput.payload,
        reset: true,
        startCursor: { seq: 1 },
        endCursor: { seq: 3 },
        entries: [
          makeTimelineEntry(1, "first"),
          makeTimelineEntry(2, "second"),
          makeTimelineEntry(3, "third"),
        ],
      },
    });

    expect(result.tail).not.toBe(existingTail);
    expect(result.tail.length).toBeGreaterThan(0);
    expect(result.head).toEqual([]);
    expect(result.cursorChanged).toBe(true);
    expect(result.cursor).toEqual({
      epoch: "epoch-1",
      startSeq: 1,
      endSeq: 3,
    });
    expect(result.error).toBe(null);
    expect(result.sideEffects.some((e) => e.type === "flush_pending_updates")).toBe(true);
  });

  it("uses the timeline entry timestamp as canonical", () => {
    const result = processTimelineResponse({
      ...baseTimelineInput,
      payload: {
        ...baseTimelineInput.payload,
        reset: true,
        startCursor: { seq: 1 },
        endCursor: { seq: 2 },
        entries: [
          {
            ...makeTimelineEntry(1, "hello", "user_message"),
            timestamp: new Date("2025-01-01T12:00:03Z").toISOString(),
          },
          {
            ...makeTimelineEntry(2, "reply"),
            timestamp: new Date("2025-01-01T12:00:04Z").toISOString(),
          },
        ],
      },
    });

    const user = result.tail.find((item) => item.kind === "user_message");
    const assistant = result.tail.find((item) => item.kind === "assistant_message");

    expect(user?.timestamp.toISOString()).toBe("2025-01-01T12:00:03.000Z");
    expect(assistant?.timestamp.toISOString()).toBe("2025-01-01T12:00:04.000Z");
  });

  it("reconciles an optimistic user message during tail replacement", () => {
    const image = {
      id: "optimistic-image",
      mimeType: "image/png",
      storageType: "web-indexeddb" as const,
      storageKey: "optimistic-image",
      createdAt: 1000,
    };
    const attachment = {
      type: "text" as const,
      mimeType: "text/plain" as const,
      text: "attached context",
      title: "context.txt",
    };
    const optimistic = buildOptimisticUserMessage({
      id: "optimistic-create-user",
      text: "Analyze this",
      timestamp: new Date(1000),
      images: [image],
      attachments: [attachment],
    });

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [optimistic],
      payload: {
        ...baseTimelineInput.payload,
        reset: true,
        startCursor: { seq: 1 },
        endCursor: { seq: 1 },
        entries: [
          {
            ...makeTimelineEntry(1, "Analyze this", "user_message"),
            item: {
              type: "user_message",
              text: "server-rendered attachment text",
              messageId: "canonical-create-user",
            },
          },
        ],
      },
    });

    const userMessages = result.tail.filter((item) => item.kind === "user_message");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]).toMatchObject({
      id: "canonical-create-user",
      text: "Analyze this",
      timestamp: new Date(1000),
      images: [image],
      attachments: [attachment],
    });
    expect(userMessages[0]?.optimistic).toBeUndefined();

    const repeated = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: result.tail,
      payload: {
        ...baseTimelineInput.payload,
        reset: true,
        startCursor: { seq: 1 },
        endCursor: { seq: 1 },
        entries: [
          {
            ...makeTimelineEntry(1, "Analyze this", "user_message"),
            item: {
              type: "user_message",
              text: "server-rendered attachment text",
              messageId: "canonical-create-user",
            },
          },
        ],
      },
    });

    expect(repeated.tail.filter((item) => item.kind === "user_message")).toEqual(userMessages);
  });

  it("keeps an unmatched optimistic user message during tail replacement", () => {
    const optimistic = makeOptimisticUserMessage("still sending", "optimistic-unmatched");

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [optimistic],
      payload: {
        ...baseTimelineInput.payload,
        reset: true,
        entries: [],
      },
    });

    expect(result.tail).toEqual([optimistic]);
  });

  it("sets cursor to null when reset=true but no cursors in payload", () => {
    const existingTail: StreamItem[] = [
      {
        kind: "user_message",
        id: "only-user",
        text: "first turn",
        timestamp: new Date(500),
      },
    ];
    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: existingTail,
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 5 },
      payload: {
        ...baseTimelineInput.payload,
        reset: true,
        entries: [],
      },
    });

    expect(result.cursor).toBe(null);
    expect(result.cursorChanged).toBe(true);
    expect(result.tail).toEqual([]);
    expect(getUserTexts(result.tail)).toHaveLength(0);
  });

  it("treats a stale epoch reset as a replacement with the new epoch window", () => {
    const oldTail: StreamItem[] = [makeAssistantItem("old epoch message", "old-assistant")];
    const oldHead: StreamItem[] = [makeAssistantItem("old live head", "old-head")];

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: oldTail,
      currentHead: oldHead,
      currentCursor: { epoch: "old-epoch", startSeq: 1, endSeq: 95 },
      payload: {
        ...baseTimelineInput.payload,
        reset: true,
        epoch: "new-epoch",
        startCursor: { seq: 101 },
        endCursor: { seq: 105 },
        hasOlder: true,
        entries: [
          makeTimelineEntry(101, "new one"),
          makeTimelineEntry(102, "new two"),
          makeTimelineEntry(103, "new three"),
          makeTimelineEntry(104, "new four"),
          makeTimelineEntry(105, "new five"),
        ],
      },
    });

    expect(getAssistantTexts(result.tail)).toEqual(["new onenew twonew threenew fournew five"]);
    expect(result.head).toEqual([]);
    expect(result.cursor).toEqual({ epoch: "new-epoch", startSeq: 101, endSeq: 105 });
    expect(result.sideEffects).not.toContainEqual({
      type: "catch_up",
      cursor: { epoch: "old-epoch", endSeq: 95 },
    });
  });

  it("performs bootstrap tail init with catch-up side effect", () => {
    const result = processTimelineResponse({
      ...baseTimelineInput,
      isInitializing: true,
      hasActiveInitDeferred: true,
      initRequestDirection: "tail",
      payload: {
        ...baseTimelineInput.payload,
        direction: "tail",
        epoch: "epoch-1",
        startCursor: { seq: 1 },
        endCursor: { seq: 5 },
        entries: [makeTimelineEntry(1, "first"), makeTimelineEntry(5, "last")],
      },
    });

    // Bootstrap tail replaces
    expect(result.tail.length).toBeGreaterThan(0);
    expect(result.head).toEqual([]);
    expect(result.cursorChanged).toBe(true);
    expect(result.cursor).toEqual({
      epoch: "epoch-1",
      startSeq: 1,
      endSeq: 5,
    });

    // Should have catch-up side effect
    const catchUp = result.sideEffects.find((e) => e.type === "catch_up");
    expect(catchUp).toBeDefined();
    expect(catchUp!.type === "catch_up" && catchUp!.cursor).toEqual({
      epoch: "epoch-1",
      endSeq: 5,
    });
  });

  it("appends incrementally for contiguous seqs", () => {
    const existingCursor: TimelineCursor = {
      epoch: "epoch-1",
      startSeq: 1,
      endSeq: 3,
    };

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentCursor: existingCursor,
      payload: {
        ...baseTimelineInput.payload,
        epoch: "epoch-1",
        entries: [makeTimelineEntry(4, "next-1"), makeTimelineEntry(5, "next-2")],
      },
    });

    expect(result.tail.length).toBeGreaterThan(0);
    expect(result.cursorChanged).toBe(true);
    expect(result.cursor).toEqual({
      epoch: "epoch-1",
      startSeq: 1,
      endSeq: 5,
    });
    expect(result.error).toBe(null);
  });

  it("reconciles an optimistic user message during an after-page response", () => {
    const existingCursor: TimelineCursor = {
      epoch: "epoch-1",
      startSeq: 1,
      endSeq: 1,
    };
    const optimistic = makeOptimisticUserMessage("sent while catching up", "optimistic-after");

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [optimistic],
      currentCursor: existingCursor,
      payload: {
        ...baseTimelineInput.payload,
        epoch: "epoch-1",
        entries: [
          {
            ...makeTimelineEntry(2, "sent while catching up", "user_message"),
            item: {
              type: "user_message",
              text: "sent while catching up",
              messageId: "canonical-after",
            },
          },
        ],
      },
    });

    const userMessages = result.tail.filter((item) => item.kind === "user_message");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.id).toBe("canonical-after");
    expect(userMessages[0]?.optimistic).toBeUndefined();
  });

  it("keeps an active assistant head live when an incremental fetch accepts same-turn assistant text", () => {
    const existingCursor: TimelineCursor = {
      epoch: "epoch-1",
      startSeq: 1,
      endSeq: 2,
    };
    const currentHead = [makeAssistantItem("This is a par")];

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentHead,
      currentCursor: existingCursor,
      payload: {
        ...baseTimelineInput.payload,
        epoch: "epoch-1",
        entries: [makeTimelineEntry(3, "agraph")],
      },
    });

    expect(getAssistantTexts(result.tail)).toEqual([]);
    expect(getAssistantTexts(result.head)).toEqual(["This is a paragraph"]);
    expect(result.cursor).toEqual({
      epoch: "epoch-1",
      startSeq: 1,
      endSeq: 3,
    });
  });

  it("hydrates a fetched in-progress tool call as one item and streams the next update on top", () => {
    const fetched = processTimelineResponse({
      ...baseTimelineInput,
      isInitializing: true,
      hasActiveInitDeferred: true,
      initRequestDirection: "tail",
      payload: {
        ...baseTimelineInput.payload,
        direction: "tail",
        epoch: "epoch-1",
        startCursor: { seq: 10 },
        endCursor: { seq: 250 },
        entries: [
          {
            ...makeToolCallTimelineEntry(10, "call-1", "running", {
              type: "read",
              filePath: "/tmp/example.ts",
            }),
            seqEnd: 250,
            sourceSeqRanges: [
              { startSeq: 10, endSeq: 10 },
              { startSeq: 250, endSeq: 250 },
            ],
            collapsed: ["tool_lifecycle"],
          },
        ],
      },
    });

    expect(getAgentToolCalls(fetched.tail)).toHaveLength(1);
    expect(fetched.cursor).toEqual({ epoch: "epoch-1", startSeq: 10, endSeq: 250 });

    const streamed = processAgentStreamEvent({
      ...baseStreamInput,
      currentTail: fetched.tail,
      currentHead: fetched.head,
      currentCursor: fetched.cursor ?? undefined,
      seq: 251,
      epoch: "epoch-1",
      event: {
        type: "timeline",
        provider: "claude",
        item: {
          type: "tool_call",
          callId: "call-1",
          name: "Read",
          status: "completed",
          detail: {
            type: "read",
            filePath: "/tmp/example.ts",
          },
          error: null,
        },
      } as AgentStreamEventPayload,
    });

    const tools = getAgentToolCalls(streamed.tail);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.payload.data.status).toBe("completed");
    expect(streamed.cursor).toEqual({ epoch: "epoch-1", startSeq: 10, endSeq: 251 });
  });

  it("accepts an after-page projected tool update whose item started before the cursor", () => {
    const existingCursor: TimelineCursor = {
      epoch: "epoch-1",
      startSeq: 10,
      endSeq: 249,
    };
    const runningTool = hydrateStreamState(
      [
        {
          event: makeToolCallTimelineEvent("call-1"),
          timestamp: new Date(1010),
        },
      ],
      { source: "canonical" },
    );

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: runningTool,
      currentCursor: existingCursor,
      payload: {
        ...baseTimelineInput.payload,
        direction: "after",
        epoch: "epoch-1",
        startCursor: { seq: 250 },
        endCursor: { seq: 250 },
        entries: [
          {
            ...makeToolCallTimelineEntry(10, "call-1", "completed", {
              type: "read",
              filePath: "/tmp/example.ts",
            }),
            seqEnd: 250,
            sourceSeqRanges: [
              { startSeq: 10, endSeq: 10 },
              { startSeq: 250, endSeq: 250 },
            ],
            collapsed: ["tool_lifecycle"],
          },
        ],
      },
    });

    const catchUp = result.sideEffects.find((effect) => effect.type === "catch_up");
    const tools = getAgentToolCalls(result.tail);
    expect(catchUp).toBeUndefined();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.payload.data.status).toBe("completed");
    expect(result.cursor).toEqual({ epoch: "epoch-1", startSeq: 10, endSeq: 250 });
  });

  it("replaces an active assistant head when after-page returns a full projected assistant item", () => {
    const existingCursor: TimelineCursor = {
      epoch: "epoch-1",
      startSeq: 1,
      endSeq: 3,
    };
    const currentHead = [makeAssistantItem("ABC")];

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentHead,
      currentCursor: existingCursor,
      payload: {
        ...baseTimelineInput.payload,
        direction: "after",
        epoch: "epoch-1",
        startCursor: { seq: 4 },
        endCursor: { seq: 5 },
        entries: [
          {
            ...makeTimelineEntry(1, "ABCDE"),
            seqEnd: 5,
            sourceSeqRanges: [{ startSeq: 1, endSeq: 5 }],
            collapsed: ["assistant_merge"],
          },
        ],
      },
    });

    expect(getAssistantTexts(result.tail)).toEqual([]);
    expect(getAssistantTexts(result.head)).toEqual(["ABCDE"]);
    expect(result.cursor).toEqual({ epoch: "epoch-1", startSeq: 1, endSeq: 5 });
  });

  it("detects gap and emits catch-up side effect", () => {
    const existingCursor: TimelineCursor = {
      epoch: "epoch-1",
      startSeq: 1,
      endSeq: 3,
    };

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentCursor: existingCursor,
      payload: {
        ...baseTimelineInput.payload,
        epoch: "epoch-1",
        entries: [makeTimelineEntry(10, "far ahead")],
      },
    });

    // Gap should trigger catch-up
    const catchUp = result.sideEffects.find((e) => e.type === "catch_up");
    expect(catchUp).toBeDefined();
    expect(catchUp!.type === "catch_up" && catchUp!.cursor).toEqual({
      epoch: "epoch-1",
      endSeq: 3,
    });
  });

  it("drops stale entries silently", () => {
    const existingCursor: TimelineCursor = {
      epoch: "epoch-1",
      startSeq: 1,
      endSeq: 8,
    };

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentCursor: existingCursor,
      payload: {
        ...baseTimelineInput.payload,
        epoch: "epoch-1",
        entries: [makeTimelineEntry(5, "old"), makeTimelineEntry(7, "also old")],
      },
    });

    // No new items appended (all dropped as stale)
    expect(result.tail).toBe(baseTimelineInput.currentTail);
    expect(result.cursorChanged).toBe(false);
  });

  it("prepends older before-cursor entries and only expands the start cursor", () => {
    const currentTail: StreamItem[] = [
      {
        kind: "user_message",
        id: "current-3",
        text: "current-3",
        timestamp: new Date(3000),
      },
    ];
    const currentHead = [makeAssistantItem("live head")];
    const existingCursor: TimelineCursor = {
      epoch: "epoch-1",
      startSeq: 3,
      endSeq: 5,
    };

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail,
      currentHead,
      currentCursor: existingCursor,
      payload: {
        ...baseTimelineInput.payload,
        direction: "before",
        epoch: "epoch-1",
        startCursor: { seq: 1 },
        endCursor: { seq: 2 },
        entries: [
          makeTimelineEntry(1, "older-1", "user_message"),
          makeTimelineEntry(2, "older-2", "user_message"),
        ],
      },
    });

    expect(getUserTexts(result.tail)).toEqual(["older-1", "older-2", "current-3"]);
    expect(result.head).toBe(currentHead);
    expect(result.cursorChanged).toBe(true);
    expect(result.cursor).toEqual({
      epoch: "epoch-1",
      startSeq: 1,
      endSeq: 5,
    });
  });

  it("does not reconcile an active optimistic user message from a before-page response", () => {
    const optimistic = makeOptimisticUserMessage("active prompt", "optimistic-active");
    const existingCursor: TimelineCursor = {
      epoch: "epoch-1",
      startSeq: 3,
      endSeq: 5,
    };

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [optimistic],
      currentCursor: existingCursor,
      payload: {
        ...baseTimelineInput.payload,
        direction: "before",
        epoch: "epoch-1",
        startCursor: { seq: 1 },
        endCursor: { seq: 2 },
        entries: [
          {
            ...makeTimelineEntry(1, "older prompt", "user_message"),
            item: {
              type: "user_message",
              text: "older prompt",
              messageId: "canonical-before",
            },
          },
        ],
      },
    });

    const userMessages = result.tail.filter((item) => item.kind === "user_message");
    expect(userMessages).toHaveLength(2);
    expect(userMessages.map((item) => item.id)).toEqual(["canonical-before", "optimistic-active"]);
    expect(userMessages[1]?.optimistic).toBe(true);
  });

  it("leaves the cursor alone when a before page makes no progress", () => {
    const currentTail: StreamItem[] = [
      {
        kind: "user_message",
        id: "current-3",
        text: "current-3",
        timestamp: new Date(3000),
      },
    ];
    const existingCursor: TimelineCursor = {
      epoch: "epoch-1",
      startSeq: 3,
      endSeq: 5,
    };

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail,
      currentCursor: existingCursor,
      payload: {
        ...baseTimelineInput.payload,
        direction: "before",
        epoch: "epoch-1",
        startCursor: { seq: 3 },
        endCursor: { seq: 4 },
        entries: [
          makeTimelineEntry(3, "overlap-3", "user_message"),
          makeTimelineEntry(4, "overlap-4", "user_message"),
        ],
      },
    });

    expect(result.tail).toBe(currentTail);
    expect(result.cursorChanged).toBe(false);
    expect(result.cursor).toBe(existingCursor);
  });

  it("merges assistant chunks across the older-page prepend boundary", () => {
    const currentTail = [makeAssistantItem("newer chunk", "assistant-newer")];
    const existingCursor: TimelineCursor = {
      epoch: "epoch-1",
      startSeq: 3,
      endSeq: 5,
    };

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail,
      currentCursor: existingCursor,
      payload: {
        ...baseTimelineInput.payload,
        direction: "before",
        epoch: "epoch-1",
        startCursor: { seq: 1 },
        endCursor: { seq: 2 },
        entries: [makeTimelineEntry(1, "older chunk ")],
      },
    });

    expect(getAssistantTexts(result.tail)).toEqual(["older chunk newer chunk"]);
    expect(result.cursor).toEqual({
      epoch: "epoch-1",
      startSeq: 1,
      endSeq: 5,
    });
  });

  it("coalesces tool call lifecycle rows across the older-page prepend boundary", () => {
    const callId = "toolu_boundary";
    const currentTail = hydrateStreamState(
      [
        {
          event: {
            type: "timeline",
            provider: "claude",
            item: makeToolCallTimelineEntry(3, callId, "completed", {
              type: "read",
              filePath: "/tmp/example.ts",
            }).item,
          } as AgentStreamEventPayload,
          timestamp: new Date(3000),
        },
      ],
      { source: "canonical" },
    );
    const existingCursor: TimelineCursor = {
      epoch: "epoch-1",
      startSeq: 3,
      endSeq: 5,
    };

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail,
      currentCursor: existingCursor,
      payload: {
        ...baseTimelineInput.payload,
        direction: "before",
        epoch: "epoch-1",
        startCursor: { seq: 1 },
        endCursor: { seq: 2 },
        entries: [
          makeToolCallTimelineEntry(1, callId, "running", {
            type: "unknown",
            input: { file_path: "/tmp/example.ts" },
            output: null,
          }),
        ],
      },
    });

    const toolCalls = getAgentToolCalls(result.tail);
    expect(
      toolCalls.map((item) => ({
        id: item.id,
        callId: item.payload.data.callId,
        status: item.payload.data.status,
        detailType: item.payload.data.detail.type,
      })),
    ).toEqual([
      {
        id: `agent_tool_${callId}`,
        callId,
        status: "completed",
        detailType: "read",
      },
    ]);
  });

  it("does not coalesce tool call lifecycle rows away from the prepend boundary", () => {
    const callId = "toolu_not_boundary";
    const currentTail = hydrateStreamState(
      [
        {
          event: makeTimelineEvent("current chunk"),
          timestamp: new Date(3000),
        },
        {
          event: {
            type: "timeline",
            provider: "claude",
            item: makeToolCallTimelineEntry(4, callId, "completed", {
              type: "read",
              filePath: "/tmp/example.ts",
            }).item,
          } as AgentStreamEventPayload,
          timestamp: new Date(4000),
        },
      ],
      { source: "canonical" },
    );
    const existingCursor: TimelineCursor = {
      epoch: "epoch-1",
      startSeq: 3,
      endSeq: 5,
    };

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail,
      currentCursor: existingCursor,
      payload: {
        ...baseTimelineInput.payload,
        direction: "before",
        epoch: "epoch-1",
        startCursor: { seq: 1 },
        endCursor: { seq: 2 },
        entries: [
          makeToolCallTimelineEntry(1, callId, "running", {
            type: "unknown",
            input: { file_path: "/tmp/example.ts" },
            output: null,
          }),
          makeTimelineEntry(2, "older chunk "),
        ],
      },
    });

    expect(
      result.tail.map((item) => ({
        kind: item.kind,
        id: item.id,
        status: item.kind === "tool_call" ? item.payload.data.status : null,
        text: item.kind === "assistant_message" ? item.text : null,
      })),
    ).toEqual([
      {
        kind: "tool_call",
        id: `agent_tool_${callId}`,
        status: "running",
        text: null,
      },
      {
        kind: "assistant_message",
        id: expect.any(String),
        status: null,
        text: "older chunk current chunk",
      },
      {
        kind: "tool_call",
        id: `agent_tool_${callId}`,
        status: "completed",
        text: null,
      },
    ]);
  });

  it("requests canonical catch-up when a projected entry overlaps unseen seqs", () => {
    const existingCursor: TimelineCursor = {
      epoch: "epoch-1",
      startSeq: 1,
      endSeq: 5,
    };

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentCursor: existingCursor,
      payload: {
        ...baseTimelineInput.payload,
        epoch: "epoch-1",
        entries: [
          {
            ...makeTimelineEntry(4, "merged assistant message"),
            seqEnd: 8,
          },
        ],
      },
    });

    expect(result.tail).toBe(baseTimelineInput.currentTail);
    expect(result.cursorChanged).toBe(false);
    expect(result.sideEffects).toContainEqual({
      type: "catch_up",
      cursor: {
        epoch: "epoch-1",
        endSeq: 5,
      },
    });
  });

  it("drops entries with epoch mismatch", () => {
    const existingCursor: TimelineCursor = {
      epoch: "epoch-1",
      startSeq: 1,
      endSeq: 5,
    };

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentCursor: existingCursor,
      payload: {
        ...baseTimelineInput.payload,
        epoch: "epoch-2",
        entries: [makeTimelineEntry(6, "different epoch")],
      },
    });

    expect(result.tail).toBe(baseTimelineInput.currentTail);
    expect(result.cursorChanged).toBe(false);
  });

  it("resolves init when deferred matches direction", () => {
    const result = processTimelineResponse({
      ...baseTimelineInput,
      isInitializing: true,
      hasActiveInitDeferred: true,
      initRequestDirection: "after",
      payload: {
        ...baseTimelineInput.payload,
        direction: "after",
        entries: [],
      },
    });

    expect(result.initResolution).toBe("resolve");
    expect(result.clearInitializing).toBe(true);
  });

  it("keeps init open while an after catch-up page has newer rows", () => {
    const result = processTimelineResponse({
      ...baseTimelineInput,
      isInitializing: true,
      hasActiveInitDeferred: true,
      initRequestDirection: "after",
      payload: {
        ...baseTimelineInput.payload,
        direction: "after",
        hasNewer: true,
        entries: [],
      },
    });

    expect(result.initResolution).toBe(null);
    expect(result.clearInitializing).toBe(false);
  });

  it("does not resolve init when directions differ (before vs after)", () => {
    const result = processTimelineResponse({
      ...baseTimelineInput,
      isInitializing: true,
      hasActiveInitDeferred: true,
      initRequestDirection: "after",
      payload: {
        ...baseTimelineInput.payload,
        direction: "before",
        entries: [],
      },
    });

    // "before" direction doesn't match "after" initRequestDirection,
    // and "before" is not a bootstrap tail path, so init should NOT resolve
    expect(result.initResolution).toBe(null);
    expect(result.clearInitializing).toBe(false);
  });

  it("clears initializing even without deferred", () => {
    const result = processTimelineResponse({
      ...baseTimelineInput,
      isInitializing: true,
      hasActiveInitDeferred: false,
      payload: {
        ...baseTimelineInput.payload,
        direction: "after",
        entries: [],
      },
    });

    expect(result.clearInitializing).toBe(true);
    expect(result.initResolution).toBe(null);
  });

  it("always includes flush_pending_updates side effect on success", () => {
    const result = processTimelineResponse({
      ...baseTimelineInput,
      payload: {
        ...baseTimelineInput.payload,
        entries: [],
      },
    });

    expect(result.sideEffects.some((e) => e.type === "flush_pending_updates")).toBe(true);
  });

  it("initializes cursor when no existing cursor on first entries", () => {
    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentCursor: undefined,
      payload: {
        ...baseTimelineInput.payload,
        epoch: "epoch-1",
        entries: [makeTimelineEntry(1, "first"), makeTimelineEntry(2, "second")],
      },
    });

    expect(result.cursorChanged).toBe(true);
    expect(result.cursor).toEqual({
      epoch: "epoch-1",
      startSeq: 1,
      endSeq: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// processAgentStreamEvent
// ---------------------------------------------------------------------------

describe("processAgentStreamEvent", () => {
  it("passes through non-timeline events without cursor changes", () => {
    const turnEvent: AgentStreamEventPayload = {
      type: "turn_completed",
      provider: "claude",
    };

    const result = processAgentStreamEvent({
      ...baseStreamInput,
      event: turnEvent,
      seq: undefined,
      epoch: undefined,
    });

    expect(result.cursorChanged).toBe(false);
    expect(result.cursor).toBe(null);
    expect(result.sideEffects).toEqual([]);
  });

  it("accepts timeline event with cursor advance", () => {
    const existingCursor: TimelineCursor = {
      epoch: "epoch-1",
      startSeq: 1,
      endSeq: 4,
    };

    const result = processAgentStreamEvent({
      ...baseStreamInput,
      event: makeTimelineEvent("new chunk"),
      seq: 5,
      epoch: "epoch-1",
      currentCursor: existingCursor,
    });

    expect(result.cursorChanged).toBe(true);
    expect(result.cursor).toEqual({
      epoch: "epoch-1",
      startSeq: 1,
      endSeq: 5,
    });
    expect(result.sideEffects).toEqual([]);
  });

  it("detects gap and emits catch-up side effect", () => {
    const existingCursor: TimelineCursor = {
      epoch: "epoch-1",
      startSeq: 1,
      endSeq: 4,
    };

    const result = processAgentStreamEvent({
      ...baseStreamInput,
      event: makeTimelineEvent("far ahead"),
      seq: 10,
      epoch: "epoch-1",
      currentCursor: existingCursor,
    });

    expect(result.cursorChanged).toBe(false);
    expect(result.changedTail).toBe(false);
    expect(result.changedHead).toBe(false);

    const catchUp = result.sideEffects.find((e) => e.type === "catch_up");
    expect(catchUp).toBeDefined();
    expect(catchUp!.cursor).toEqual({
      epoch: "epoch-1",
      endSeq: 4,
    });
  });

  it("drops stale timeline event", () => {
    const existingCursor: TimelineCursor = {
      epoch: "epoch-1",
      startSeq: 1,
      endSeq: 8,
    };

    const result = processAgentStreamEvent({
      ...baseStreamInput,
      event: makeTimelineEvent("old"),
      seq: 5,
      epoch: "epoch-1",
      currentCursor: existingCursor,
    });

    expect(result.cursorChanged).toBe(false);
    expect(result.changedTail).toBe(false);
    expect(result.changedHead).toBe(false);
    expect(result.sideEffects).toEqual([]);
  });

  it("drops timeline event with epoch mismatch", () => {
    const existingCursor: TimelineCursor = {
      epoch: "epoch-1",
      startSeq: 1,
      endSeq: 5,
    };

    const result = processAgentStreamEvent({
      ...baseStreamInput,
      event: makeTimelineEvent("wrong epoch"),
      seq: 6,
      epoch: "epoch-2",
      currentCursor: existingCursor,
    });

    expect(result.cursorChanged).toBe(false);
    expect(result.changedTail).toBe(false);
    expect(result.changedHead).toBe(false);
    expect(result.sideEffects).toEqual([]);
  });

  it("resets visible timeline when a new epoch starts at seq 1", () => {
    const existingCursor: TimelineCursor = {
      epoch: "epoch-1",
      startSeq: 1,
      endSeq: 5,
    };
    const currentTail = [makeAssistantItem("old timeline")];

    const result = processAgentStreamEvent({
      ...baseStreamInput,
      event: makeTimelineEvent("rewound start", "user_message"),
      seq: 1,
      epoch: "epoch-2",
      currentCursor: existingCursor,
      currentTail,
    });

    expect(result.cursorChanged).toBe(true);
    expect(result.cursor).toEqual({
      epoch: "epoch-2",
      startSeq: 1,
      endSeq: 1,
    });
    expect(getAssistantTexts(result.tail)).toEqual([]);
    expect(getUserTexts(result.tail)).toEqual(["rewound start"]);
    expect(result.sideEffects).toEqual([]);
  });

  it("initializes cursor when none exists", () => {
    const result = processAgentStreamEvent({
      ...baseStreamInput,
      event: makeTimelineEvent("first"),
      seq: 1,
      epoch: "epoch-1",
      currentCursor: undefined,
    });

    expect(result.cursorChanged).toBe(true);
    expect(result.cursor).toEqual({
      epoch: "epoch-1",
      startSeq: 1,
      endSeq: 1,
    });
  });

  it("derives optimistic idle status on turn_completed for running agent", () => {
    const turnCompletedEvent: AgentStreamEventPayload = {
      type: "turn_completed",
      provider: "claude",
    };

    const result = processAgentStreamEvent({
      ...baseStreamInput,
      event: turnCompletedEvent,
      currentAgent: {
        status: "running",
        updatedAt: new Date(1000),
        lastActivityAt: new Date(1000),
      },
      timestamp: new Date(2000),
    });

    expect(result.agentChanged).toBe(true);
    expect(result.agent).not.toBe(null);
    expect(result.agent!.status).toBe("idle");
    expect(result.agent!.updatedAt.getTime()).toBe(2000);
    expect(result.agent!.lastActivityAt.getTime()).toBe(2000);
  });

  it("derives optimistic error status on turn_failed for running agent", () => {
    const turnFailedEvent: AgentStreamEventPayload = {
      type: "turn_failed",
      provider: "claude",
      error: "something broke",
    };

    const result = processAgentStreamEvent({
      ...baseStreamInput,
      event: turnFailedEvent,
      currentAgent: {
        status: "running",
        updatedAt: new Date(1000),
        lastActivityAt: new Date(1000),
      },
      timestamp: new Date(2000),
    });

    expect(result.agentChanged).toBe(true);
    expect(result.agent!.status).toBe("error");
  });

  it("does not derive optimistic idle status on turn_canceled for running agent", () => {
    const turnCanceledEvent: AgentStreamEventPayload = {
      type: "turn_canceled",
      provider: "codex",
      reason: "interrupted",
    };

    const result = processAgentStreamEvent({
      ...baseStreamInput,
      event: turnCanceledEvent,
      currentAgent: {
        status: "running",
        updatedAt: new Date(1000),
        lastActivityAt: new Date(1000),
      },
      timestamp: new Date(2000),
    });

    expect(result.agentChanged).toBe(false);
    expect(result.agent).toBe(null);
  });

  it("does not change agent when status is not running", () => {
    const turnCompletedEvent: AgentStreamEventPayload = {
      type: "turn_completed",
      provider: "claude",
    };

    const result = processAgentStreamEvent({
      ...baseStreamInput,
      event: turnCompletedEvent,
      currentAgent: {
        status: "idle",
        updatedAt: new Date(1000),
        lastActivityAt: new Date(1000),
      },
      timestamp: new Date(2000),
    });

    expect(result.agentChanged).toBe(false);
    expect(result.agent).toBe(null);
  });

  it("does not change agent when no agent is provided", () => {
    const turnCompletedEvent: AgentStreamEventPayload = {
      type: "turn_completed",
      provider: "claude",
    };

    const result = processAgentStreamEvent({
      ...baseStreamInput,
      event: turnCompletedEvent,
      currentAgent: null,
      timestamp: new Date(2000),
    });

    expect(result.agentChanged).toBe(false);
    expect(result.agent).toBe(null);
  });

  it("preserves updatedAt when agent timestamp is newer than event", () => {
    const turnCompletedEvent: AgentStreamEventPayload = {
      type: "turn_completed",
      provider: "claude",
    };

    const result = processAgentStreamEvent({
      ...baseStreamInput,
      event: turnCompletedEvent,
      currentAgent: {
        status: "running",
        updatedAt: new Date(5000),
        lastActivityAt: new Date(5000),
      },
      timestamp: new Date(2000),
    });

    expect(result.agentChanged).toBe(true);
    expect(result.agent!.updatedAt.getTime()).toBe(5000);
    expect(result.agent!.lastActivityAt.getTime()).toBe(5000);
  });

  it("does not produce agent patch for non-terminal events", () => {
    const result = processAgentStreamEvent({
      ...baseStreamInput,
      event: makeTimelineEvent("just text"),
      currentAgent: {
        status: "running",
        updatedAt: new Date(1000),
        lastActivityAt: new Date(1000),
      },
      seq: 1,
      epoch: "epoch-1",
      timestamp: new Date(2000),
    });

    expect(result.agentChanged).toBe(false);
    expect(result.agent).toBe(null);
  });
});

describe("processAgentStreamEvents", () => {
  it("coalesces contiguous assistant stream events into one head update and final cursor", () => {
    const result = processAgentStreamEvents({
      events: [
        makeStreamReducerEvent(makeTimelineEvent("Hello"), 1),
        makeStreamReducerEvent(makeTimelineEvent(" world"), 2),
      ],
      currentTail: [],
      currentHead: [],
      currentCursor: undefined,
      currentAgent: null,
    });

    expect(result.changedTail).toBe(false);
    expect(result.changedHead).toBe(true);
    expect(result.tail).toEqual([]);
    expect(result.head).toHaveLength(1);
    expect(result.head[0]).toMatchObject({
      kind: "assistant_message",
      text: "Hello world",
    });
    expect(result.cursor).toEqual({
      epoch: "epoch-1",
      startSeq: 1,
      endSeq: 2,
    } satisfies TimelineCursor);
    expect(result.sideEffects).toEqual([]);
  });

  it("keeps matching assistant message ids in the live head", () => {
    const result = processAgentStreamEvents({
      events: [
        makeStreamReducerEvent(makeAssistantTimelineEvent("Hel", "assistant-one"), 1),
        makeStreamReducerEvent(makeAssistantTimelineEvent("lo", "assistant-one"), 2),
      ],
      currentTail: [],
      currentHead: [],
      currentCursor: undefined,
      currentAgent: null,
    });

    expect(result.changedTail).toBe(false);
    expect(result.changedHead).toBe(true);
    expect(result.tail).toEqual([]);
    expect(result.head).toHaveLength(1);
    expect(result.head[0]).toMatchObject({
      kind: "assistant_message",
      text: "Hello",
      messageId: "assistant-one",
    });
  });

  it("flushes the live assistant head before starting a different assistant message id", () => {
    const result = processAgentStreamEvents({
      events: [
        makeStreamReducerEvent(makeAssistantTimelineEvent("First", "assistant-one"), 1),
        makeStreamReducerEvent(makeAssistantTimelineEvent("Second", "assistant-two"), 2),
      ],
      currentTail: [],
      currentHead: [],
      currentCursor: undefined,
      currentAgent: null,
    });

    expect(result.changedTail).toBe(true);
    expect(result.changedHead).toBe(true);
    expect(getAssistantTexts(result.tail)).toEqual(["First"]);
    expect(getAssistantTexts(result.head)).toEqual(["Second"]);
  });

  it("flushes an anonymous assistant head before starting an identified assistant message", () => {
    const result = processAgentStreamEvents({
      events: [
        makeStreamReducerEvent(makeAssistantTimelineEvent("Anonymous"), 1),
        makeStreamReducerEvent(makeAssistantTimelineEvent("Identified", "assistant-two"), 2),
      ],
      currentTail: [],
      currentHead: [],
      currentCursor: undefined,
      currentAgent: null,
    });

    expect(result.changedTail).toBe(true);
    expect(result.changedHead).toBe(true);
    expect(getAssistantTexts(result.tail)).toEqual(["Anonymous"]);
    expect(getAssistantTexts(result.head)).toEqual(["Identified"]);
  });

  it("promotes completed assistant markdown blocks to tail while keeping the live block in head", () => {
    const result = processAgentStreamEvents({
      events: [
        makeStreamReducerEvent(makeTimelineEvent("First paragraph"), 1),
        makeStreamReducerEvent(makeTimelineEvent("\n\nSecond paragraph"), 2),
      ],
      currentTail: [],
      currentHead: [],
      currentCursor: undefined,
      currentAgent: null,
    });

    expect(result.changedTail).toBe(true);
    expect(result.changedHead).toBe(true);
    expect(result.tail).toHaveLength(1);
    expect(result.tail[0]).toMatchObject({
      kind: "assistant_message",
      text: "First paragraph",
    });
    expect(result.head).toHaveLength(1);
    expect(result.head[0]).toMatchObject({
      kind: "assistant_message",
      text: "Second paragraph",
    });
  });

  it("preserves a live block trailing newline after promoting completed markdown blocks", () => {
    const result = processAgentStreamEvents({
      events: [
        makeStreamReducerEvent(
          makeTimelineEvent(
            "Done. I added `[TimelineMerge] ...` logging around the suspicious merge",
          ),
          238,
        ),
        makeStreamReducerEvent(makeTimelineEvent("/reconcile paths.\n\nChanged:\n"), 239),
        makeStreamReducerEvent(makeTimelineEvent("- [timeline-debug.ts]"), 240),
      ],
      currentTail: [],
      currentHead: [],
      currentCursor: undefined,
      currentAgent: null,
    });

    expect(result.changedTail).toBe(true);
    expect(result.changedHead).toBe(true);
    expect(result.tail).toHaveLength(1);
    expect(result.tail[0]).toMatchObject({
      kind: "assistant_message",
      text: "Done. I added `[TimelineMerge] ...` logging around the suspicious merge/reconcile paths.",
    });
    expect(result.head).toHaveLength(1);
    expect(result.head[0]).toMatchObject({
      kind: "assistant_message",
      text: "Changed:\n- [timeline-debug.ts]",
    });
  });

  it("does not promote a markdown block that is still inside an open code fence", () => {
    const result = processAgentStreamEvents({
      events: [
        makeStreamReducerEvent(makeTimelineEvent("Before fence\n\n```ts\nconst a = 1;"), 1),
        makeStreamReducerEvent(makeTimelineEvent("\n\nconst b = 2;"), 2),
      ],
      currentTail: [],
      currentHead: [],
      currentCursor: undefined,
      currentAgent: null,
    });

    expect(result.changedTail).toBe(true);
    expect(result.tail).toHaveLength(1);
    expect(result.tail[0]).toMatchObject({
      kind: "assistant_message",
      text: "Before fence",
    });
    expect(result.head).toHaveLength(1);
    expect(result.head[0]).toMatchObject({
      kind: "assistant_message",
      text: "```ts\nconst a = 1;\n\nconst b = 2;",
    });
  });

  it("flushes the live assistant block before applying a tool call in the same reducer pass", () => {
    const result = processAgentStreamEvents({
      events: [
        makeStreamReducerEvent(makeTimelineEvent("Before tool"), 1),
        makeStreamReducerEvent(makeToolCallTimelineEvent("call-1"), 2),
      ],
      currentTail: [],
      currentHead: [],
      currentCursor: undefined,
      currentAgent: null,
    });

    expect(result.changedTail).toBe(true);
    expect(result.changedHead).toBe(true);
    expect(result.head).toEqual([]);
    expect(result.tail.map((item: StreamItem) => item.kind)).toEqual([
      "assistant_message",
      "tool_call",
    ]);
    expect(result.cursor).toEqual({
      epoch: "epoch-1",
      startSeq: 1,
      endSeq: 2,
    } satisfies TimelineCursor);
  });

  it("keeps Claude image tool-result output before following assistant blocks while text streams", () => {
    const imageMarkdown =
      "![Image](/tmp/paseo-attachments/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png)";
    const result = processAgentStreamEvents({
      events: [
        makeStreamReducerEvent(
          {
            type: "timeline",
            provider: "claude",
            item: {
              type: "assistant_message",
              text: "ABC",
              messageId: "assistant-before",
            },
          } as AgentStreamEventPayload,
          1,
        ),
        makeStreamReducerEvent(makeToolCallTimelineEvent("toolu_read_png"), 2),
        makeStreamReducerEvent(
          {
            type: "timeline",
            provider: "claude",
            item: {
              type: "tool_call",
              callId: "toolu_read_png",
              name: "Read",
              status: "completed",
              detail: {
                type: "read",
                filePath: "/tmp/image.png",
              },
              error: null,
            },
          } as AgentStreamEventPayload,
          3,
        ),
        makeStreamReducerEvent(
          {
            type: "timeline",
            provider: "claude",
            item: {
              type: "assistant_message",
              text: imageMarkdown,
            },
          } as AgentStreamEventPayload,
          4,
        ),
        makeStreamReducerEvent(
          {
            type: "timeline",
            provider: "claude",
            item: {
              type: "assistant_message",
              text: "D",
              messageId: "assistant-after",
            },
          } as AgentStreamEventPayload,
          5,
        ),
        makeStreamReducerEvent(
          {
            type: "timeline",
            provider: "claude",
            item: {
              type: "assistant_message",
              text: "\n\nE",
              messageId: "assistant-after",
            },
          } as AgentStreamEventPayload,
          6,
        ),
      ],
      currentTail: [],
      currentHead: [],
      currentCursor: undefined,
      currentAgent: null,
    });

    expect(getAssistantTexts([...result.tail, ...result.head])).toEqual([
      "ABC",
      imageMarkdown,
      "D",
      "E",
    ]);
  });

  it("returns the final optimistic lifecycle patch across a batch", () => {
    const result = processAgentStreamEvents({
      events: [
        makeStreamReducerEvent(makeTimelineEvent("Done"), 1),
        {
          event: { type: "turn_completed", provider: "claude" } as AgentStreamEventPayload,
          seq: undefined,
          epoch: undefined,
          timestamp: new Date(3000),
        },
      ],
      currentTail: [],
      currentHead: [],
      currentCursor: undefined,
      currentAgent: {
        status: "running",
        updatedAt: new Date(1000),
        lastActivityAt: new Date(1000),
      },
    });

    expect(result.head).toEqual([]);
    expect(result.tail).toHaveLength(1);
    expect(result.agentChanged).toBe(true);
    expect(result.agent).toMatchObject({
      status: "idle",
      updatedAt: new Date(3000),
      lastActivityAt: new Date(3000),
    });
  });

  it("keeps a live Claude assistant paragraph contiguous when init tail hydration lands mid-stream", () => {
    const seq186Text = "Now let me write the updated tool-call-detail-parser.ts with all the sub";
    const seq187Text = "agent additions.";

    const liveSeq186 = processAgentStreamEvent({
      ...baseStreamInput,
      event: makeTimelineEvent(seq186Text),
      seq: 186,
      epoch: "epoch-1",
      currentTail: [],
      currentHead: [],
      currentCursor: undefined,
      timestamp: new Date("2026-05-02T10:00:00.186Z"),
    });

    expect(getAssistantTexts(liveSeq186.head)).toEqual([seq186Text]);
    expect(getAssistantTexts(liveSeq186.tail)).toEqual([]);

    const initTailHydration = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: liveSeq186.tail,
      currentHead: liveSeq186.head,
      currentCursor: liveSeq186.cursor ?? undefined,
      isInitializing: true,
      hasActiveInitDeferred: true,
      initRequestDirection: "tail",
      payload: {
        agentId: "agent-1",
        direction: "tail",
        reset: false,
        epoch: "epoch-1",
        startCursor: { seq: 186 },
        endCursor: { seq: 186 },
        entries: [makeTimelineEntry(186, seq186Text)],
        error: null,
        hasNewer: false,
        hasOlder: false,
      },
    });

    expect(getAssistantTexts(initTailHydration.tail)).toEqual([]);
    expect(getAssistantTexts(initTailHydration.head)).toEqual([seq186Text]);

    const liveSeq187 = processAgentStreamEvent({
      ...baseStreamInput,
      event: makeTimelineEvent(seq187Text),
      seq: 187,
      epoch: "epoch-1",
      currentTail: initTailHydration.tail,
      currentHead: initTailHydration.head,
      currentCursor: initTailHydration.cursor ?? undefined,
      timestamp: new Date("2026-05-02T10:00:00.187Z"),
    });

    const finalAssistantItems = [...liveSeq187.tail, ...liveSeq187.head].filter(
      (item): item is Extract<StreamItem, { kind: "assistant_message" }> =>
        item.kind === "assistant_message",
    );

    expect(finalAssistantItems).toHaveLength(1);
    expect(finalAssistantItems[0]?.text).toBe(`${seq186Text}${seq187Text}`);
  });

  it("does not split an assistant sentence between hydrated tail and live head", () => {
    const hydrated = processTimelineResponse({
      ...baseTimelineInput,
      isInitializing: true,
      hasActiveInitDeferred: true,
      initRequestDirection: "tail",
      payload: {
        agentId: "agent-1",
        direction: "tail",
        reset: false,
        epoch: "epoch-1",
        startCursor: { seq: 10 },
        endCursor: { seq: 10 },
        entries: [makeTimelineEntry(10, "Call-site API — exactly one primitive. Not")],
        error: null,
        hasNewer: false,
        hasOlder: false,
      },
    });

    const liveContinuation = processAgentStreamEvent({
      ...baseStreamInput,
      event: makeTimelineEvent(" gateValue, not filterEnum."),
      seq: 11,
      epoch: "epoch-1",
      currentTail: hydrated.tail,
      currentHead: hydrated.head,
      currentCursor: hydrated.cursor ?? undefined,
      timestamp: new Date("2026-05-02T10:00:00.011Z"),
    });

    const finalAssistantItems = [...liveContinuation.tail, ...liveContinuation.head].filter(
      (item): item is Extract<StreamItem, { kind: "assistant_message" }> =>
        item.kind === "assistant_message",
    );

    expect(finalAssistantItems).toHaveLength(1);
    expect(finalAssistantItems[0]?.text).toBe(
      "Call-site API — exactly one primitive. Not gateValue, not filterEnum.",
    );
  });
});

describe("createAgentStreamReducerQueue", () => {
  function createManualScheduler() {
    let nextId = 1;
    const callbacks = new Map<number, () => void>();
    return {
      schedule(callback: () => void) {
        const id = nextId;
        nextId += 1;
        callbacks.set(id, callback);
        return id;
      },
      cancel(id: number) {
        callbacks.delete(id);
      },
      flushOne() {
        const entry = callbacks.entries().next().value;
        if (!entry) {
          throw new Error("Expected a scheduled callback");
        }
        const [id, callback] = entry;
        callbacks.delete(id);
        callback();
      },
      get size() {
        return callbacks.size;
      },
    };
  }

  it("coalesces multiple events for one agent into one scheduled commit", () => {
    const scheduler = createManualScheduler();
    const commits: Array<{ agentId: string; headText: string; cursorEndSeq: number | null }> = [];
    let currentTail: StreamItem[] = [];
    let currentHead: StreamItem[] = [];

    const queue = createAgentStreamReducerQueue({
      getSnapshot: () => ({
        currentTail,
        currentHead,
        currentCursor: undefined,
        currentAgent: null,
      }),
      commit: (agentId, result) => {
        currentTail = result.tail;
        currentHead = result.head;
        commits.push({
          agentId,
          headText: result.head[0]?.kind === "assistant_message" ? result.head[0].text : "",
          cursorEndSeq: result.cursor?.endSeq ?? null,
        });
      },
      handleSideEffects: () => {},
      scheduleFlush: scheduler.schedule,
      cancelFlush: scheduler.cancel,
    });

    queue.enqueue("agent-1", makeStreamReducerEvent(makeTimelineEvent("Hello"), 1));
    queue.enqueue("agent-1", makeStreamReducerEvent(makeTimelineEvent(" world"), 2));

    expect(scheduler.size).toBe(1);
    expect(commits).toEqual([]);

    scheduler.flushOne();

    expect(commits).toEqual([
      {
        agentId: "agent-1",
        headText: "Hello world",
        cursorEndSeq: 2,
      },
    ]);
    expect(scheduler.size).toBe(0);
  });

  it("flushes queued events synchronously for one agent before canonical history is applied", () => {
    const scheduler = createManualScheduler();
    const commits: string[] = [];
    const queue = createAgentStreamReducerQueue({
      getSnapshot: () => ({
        currentTail: [],
        currentHead: [],
        currentCursor: undefined,
        currentAgent: null,
      }),
      commit: (agentId, result) => {
        commits.push(
          `${agentId}:${result.head[0]?.kind === "assistant_message" ? result.head[0].text : ""}`,
        );
      },
      handleSideEffects: () => {},
      scheduleFlush: scheduler.schedule,
      cancelFlush: scheduler.cancel,
    });

    queue.enqueue("agent-1", makeStreamReducerEvent(makeTimelineEvent("queued"), 1));
    queue.flushAgent("agent-1");

    expect(commits).toEqual(["agent-1:queued"]);
    expect(scheduler.size).toBe(0);
  });

  it("keeps a live paragraph in one assistant item when canonical fetch interleaves with queued stream chunks", () => {
    const scheduler = createManualScheduler();
    let currentTail: StreamItem[] = [];
    let currentHead: StreamItem[] = [];
    let currentCursor: TimelineCursor | undefined;

    const queue = createAgentStreamReducerQueue({
      getSnapshot: () => ({
        currentTail,
        currentHead,
        currentCursor,
        currentAgent: null,
      }),
      commit: (_agentId, result) => {
        currentTail = result.tail;
        currentHead = result.head;
        currentCursor = result.cursor ?? undefined;
      },
      handleSideEffects: () => {},
      scheduleFlush: scheduler.schedule,
      cancelFlush: scheduler.cancel,
    });

    queue.enqueue("agent-1", makeStreamReducerEvent(makeTimelineEvent("This is a par"), 2));
    queue.flushAgent("agent-1");

    const timelineResult = processTimelineResponse({
      ...baseTimelineInput,
      currentTail,
      currentHead,
      currentCursor,
      payload: {
        ...baseTimelineInput.payload,
        epoch: "epoch-1",
        entries: [makeTimelineEntry(3, "agraph")],
      },
    });
    currentTail = timelineResult.tail;
    currentHead = timelineResult.head;
    currentCursor = timelineResult.cursor ?? undefined;

    queue.enqueue("agent-1", makeStreamReducerEvent(makeTimelineEvent(" continues."), 4));
    queue.flushAgent("agent-1");

    expect(getAssistantTexts(currentTail)).toEqual([]);
    expect(getAssistantTexts(currentHead)).toEqual(["This is a paragraph continues."]);
    expect(currentCursor).toEqual({
      epoch: "epoch-1",
      startSeq: 2,
      endSeq: 4,
    });
  });

  it("flushes queued events synchronously before disposal", () => {
    const scheduler = createManualScheduler();
    const commits: string[] = [];
    const queue = createAgentStreamReducerQueue({
      getSnapshot: () => ({
        currentTail: [],
        currentHead: [],
        currentCursor: undefined,
        currentAgent: null,
      }),
      commit: (agentId, result) => {
        commits.push(
          `${agentId}:${result.head[0]?.kind === "assistant_message" ? result.head[0].text : ""}`,
        );
      },
      handleSideEffects: () => {},
      scheduleFlush: scheduler.schedule,
      cancelFlush: scheduler.cancel,
    });

    queue.enqueue("agent-1", makeStreamReducerEvent(makeTimelineEvent("queued"), 1));
    queue.dispose({ flush: true });

    expect(commits).toEqual(["agent-1:queued"]);
    expect(scheduler.size).toBe(0);
  });
});
