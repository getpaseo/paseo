import { describe, expect, it } from "vitest";
import type { AgentStreamEventPayload } from "@server/shared/messages";
import type { StreamItem } from "@/types/stream";
import {
  processTimelineResponse,
  processAgentStreamEvent,
  type ProcessTimelineResponseInput,
  type ProcessAgentStreamEventInput,
  type TimelineCursor,
} from "./session-stream-reducers";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTimelineEntry(
  seq: number,
  text: string,
  type: string = "assistant_message"
) {
  return {
    seqStart: seq,
    provider: "claude",
    item: { type, text },
    timestamp: new Date(1000 + seq).toISOString(),
  };
}

function makeTimelineEvent(
  text: string,
  type: string = "assistant_message"
): AgentStreamEventPayload {
  return {
    type: "timeline",
    provider: "claude",
    item: { type, text },
  } as AgentStreamEventPayload;
}

function makeUserTimelineEvent(text: string): AgentStreamEventPayload {
  return {
    type: "timeline",
    provider: "claude",
    item: { type: "user_message", text },
  } as AgentStreamEventPayload;
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
    expect(
      result.sideEffects.some((e) => e.type === "flush_pending_updates")
    ).toBe(true);
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
        entries: [
          makeTimelineEntry(1, "first"),
          makeTimelineEntry(5, "last"),
        ],
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
        entries: [
          makeTimelineEntry(4, "next-1"),
          makeTimelineEntry(5, "next-2"),
        ],
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
        entries: [
          makeTimelineEntry(10, "far ahead"),
        ],
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
        entries: [
          makeTimelineEntry(5, "old"),
          makeTimelineEntry(7, "also old"),
        ],
      },
    });

    // No new items appended (all dropped as stale)
    expect(result.tail).toBe(baseTimelineInput.currentTail);
    expect(result.cursorChanged).toBe(false);
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
        entries: [
          makeTimelineEntry(6, "different epoch"),
        ],
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

    expect(
      result.sideEffects.some((e) => e.type === "flush_pending_updates")
    ).toBe(true);
  });

  it("initializes cursor when no existing cursor on first entries", () => {
    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentCursor: undefined,
      payload: {
        ...baseTimelineInput.payload,
        epoch: "epoch-1",
        entries: [
          makeTimelineEntry(1, "first"),
          makeTimelineEntry(2, "second"),
        ],
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
