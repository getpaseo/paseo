import { describe, expect, it } from "vitest";
import type { AgentStreamEventPayload } from "@server/shared/messages";
import type { StreamItem } from "@/types/stream";
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

  it("sets cursor to null when reset=true but no cursors in payload", () => {
    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 5 },
      payload: {
        ...baseTimelineInput.payload,
        reset: true,
        entries: [],
      },
    });

    expect(result.cursor).toBe(null);
    expect(result.cursorChanged).toBe(true);
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
