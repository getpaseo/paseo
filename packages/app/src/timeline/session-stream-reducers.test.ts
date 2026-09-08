import { describe, expect, it } from "vitest";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import type { AgentTimelineItem, ToolCallDetail } from "@getpaseo/protocol/agent-types";
import {
  createUserMessage,
  hydrateStreamState,
  type AgentToolCallItem,
  type StreamItem,
} from "@/types/stream";
import {
  createAgentStreamReducerQueue,
  deriveAgentStreamTurnLiveness,
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

type TimelineResponseEntry = ProcessTimelineResponseInput["payload"]["entries"][number];

function makeTimelineEntry(
  seq: number,
  text: string,
  type: "assistant_message" | "user_message" | "reasoning" = "assistant_message",
  seqEnd = seq,
): TimelineResponseEntry {
  let item: AgentTimelineItem;
  if (type === "assistant_message") item = { type, text };
  else if (type === "user_message") item = { type, text };
  else item = { type, text };
  return {
    seqStart: seq,
    seqEnd,
    provider: "claude",
    item,
    timestamp: new Date(1000 + seq).toISOString(),
  };
}

function makeToolCallTimelineEntry(
  seq: number,
  callId: string,
  status: "running" | "completed",
  detail: ToolCallDetail,
  turnId?: string,
): TimelineResponseEntry {
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
    ...(turnId ? { turnId } : {}),
    timestamp: new Date(1000 + seq).toISOString(),
  };
}

function makePluginTimelineEntry(seq: number, status: string): TimelineResponseEntry {
  return {
    seqStart: seq,
    seqEnd: seq,
    provider: "claude",
    item: {
      type: "plugin" as const,
      id: "review-1",
      pluginId: "review",
      kind: "review",
      version: 1,
      data: { status },
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

function makeAssistantItem(
  text: string,
  id = `assistant-${text.length}`,
): Extract<StreamItem, { kind: "assistant_message" }> {
  return {
    kind: "assistant_message",
    id,
    text,
    timestamp: new Date(1000),
  };
}

function makeSubmittedUserMessage(
  text: string,
  id = `submitted-${text.length}`,
): Extract<StreamItem, { kind: "user_message" }> {
  return createUserMessage({
    clientMessageId: id,
    text,
    timestamp: new Date(1000),
  });
}

describe("deriveAgentStreamTurnLiveness", () => {
  it("tracks start through every terminal turn event", () => {
    const started = makeStreamReducerEvent(
      { type: "turn_started", provider: "claude", turnId: "turn-1" },
      1,
    );
    expect(deriveAgentStreamTurnLiveness([started])).toEqual([
      {
        type: "stream_open",
        turn: { turnId: "turn-1", startedAt: started.timestamp },
      },
    ]);
    for (const event of [
      { type: "turn_completed", provider: "claude" },
      { type: "turn_failed", provider: "claude", error: "failed" },
      { type: "turn_canceled", provider: "claude", reason: "canceled" },
    ] as AgentStreamEventPayload[]) {
      expect(
        deriveAgentStreamTurnLiveness([
          started,
          makeStreamReducerEvent({ ...event, turnId: "turn-1" } as AgentStreamEventPayload, 2),
        ]),
      ).toEqual([
        { type: "stream_open", turn: { turnId: "turn-1", startedAt: started.timestamp } },
        { type: "stream_close", turnId: "turn-1" },
      ]);
    }
  });

  it("keeps an open turn without stream lifecycle and closes it on an ordered terminal event", () => {
    expect(
      deriveAgentStreamTurnLiveness([
        makeStreamReducerEvent(makeAssistantTimelineEvent("still working"), 1),
      ]),
    ).toEqual([]);

    expect(
      deriveAgentStreamTurnLiveness([
        makeStreamReducerEvent(
          { type: "turn_completed", provider: "claude" } as AgentStreamEventPayload,
          2,
        ),
      ]),
    ).toEqual([{ type: "stream_close", turnId: null }]);
  });

  it("restarts timing when a terminal event and the next start share one reducer batch", () => {
    const completed = makeStreamReducerEvent(
      { type: "turn_completed", provider: "claude", turnId: "turn-1" },
      2,
    );
    const restarted = makeStreamReducerEvent(
      { type: "turn_started", provider: "claude", turnId: "turn-2" },
      3,
    );

    expect(deriveAgentStreamTurnLiveness([completed, restarted])).toEqual([
      { type: "stream_close", turnId: "turn-1" },
      {
        type: "stream_open",
        turn: { turnId: "turn-2", startedAt: restarted.timestamp },
      },
    ]);
  });
});

describe("timeline turn membership compatibility", () => {
  it("hydrates tagged rows while retaining legacy rows without a turn ID", () => {
    const hydrated = hydrateStreamState([
      {
        event: {
          type: "timeline",
          provider: "claude",
          turnId: "turn-1",
          item: { type: "user_message", text: "prompt", clientMessageId: "prompt-id" },
        },
        timestamp: new Date(1000),
      },
      {
        event: {
          type: "timeline",
          provider: "claude",
          item: { type: "assistant_message", text: "legacy" },
        },
        timestamp: new Date(2000),
      },
    ]);

    expect(hydrated.map((item) => item.turnId)).toEqual(["turn-1", undefined]);
  });
});

describe("detached timeline windows", () => {
  it("does not apply or catch up live events while viewing an older window", () => {
    const currentTail = [makeAssistantItem("older window")];
    const result = processAgentStreamEvents({
      events: [makeStreamReducerEvent(makeAssistantTimelineEvent("new live output"), 101)],
      currentTail,
      currentHead: [],
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 40 },
      hasAuthoritativeBaseline: true,
      isDetached: true,
    });

    expect(result.tail).toBe(currentTail);
    expect(result.changedTail).toBe(false);
    expect(result.sideEffects).toEqual([]);
  });
});

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
    projection: "projected",
    reset: false,
    epoch: "epoch-1",
    window: { minSeq: 1, maxSeq: 0, nextSeq: 1 },
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
  sendingClientMessageIds: [],
};

const baseStreamInput: ProcessAgentStreamEventInput = {
  event: makeTimelineEvent("hello"),
  seq: undefined,
  epoch: undefined,
  currentTail: [],
  currentHead: [],
  currentCursor: undefined,
  timestamp: new Date(2000),
};

// ---------------------------------------------------------------------------
// processTimelineResponse
// ---------------------------------------------------------------------------

describe("processTimelineResponse", () => {
  it("discards an unchanged resume tail without replacing timeline state", () => {
    const canonical = createUserMessage({
      id: "canonical-prompt",
      clientMessageId: "client-message",
      messageId: "provider-message",
      text: "local prompt",
      timestamp: new Date(1000),
      timelineCursor: { epoch: "epoch-1", seq: 1 },
      turnId: "turn-1",
    });
    const hello = createUserMessage({
      id: "hello",
      clientMessageId: "hello-client",
      text: "hello",
      timestamp: new Date(1500),
      timelineCursor: { epoch: "epoch-1", seq: 2 },
      turnId: "turn-1",
    });
    const currentTail = [canonical, makeAssistantItem("existing tail", "existing-tail"), hello];
    const currentHead = [makeAssistantItem("existing head", "existing-head")];

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail,
      currentHead,
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 40 },
      payload: {
        ...baseTimelineInput.payload,
        direction: "tail",
        window: { minSeq: 1, maxSeq: 40, nextSeq: 41 },
        startCursor: { seq: 1 },
        endCursor: { seq: 40 },
        entries: [
          {
            ...makeTimelineEntry(1, "provider prompt", "user_message"),
            item: {
              type: "user_message",
              text: "provider prompt",
              messageId: "provider-message",
              clientMessageId: "client-message",
            },
          },
          makeTimelineEntry(2, "existing tail", "assistant_message", 40),
        ],
      },
    });
    expect(result.tail.find((item) => item.id === "hello")?.turnId).toBe("turn-1");

    expect(result.commit).toBe("discard");
    expect(result.tail).toBe(currentTail);
    expect(result.head).toBe(currentHead);
    expect(result.cursorChanged).toBe(false);
    expect(result.acknowledgedClientMessageIds).toEqual([]);
    expect(result.sideEffects).toEqual([{ type: "flush_pending_updates" }]);
  });

  it("atomically replaces history when a resume tail leaves a middle gap", () => {
    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [
        {
          kind: "user_message",
          id: "stale-history",
          text: "stale history",
          timestamp: new Date(1040),
          timelineCursor: { epoch: "epoch-1", seq: 40 },
        },
      ],
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 40 },
      payload: {
        ...baseTimelineInput.payload,
        direction: "tail",
        window: { minSeq: 1, maxSeq: 240, nextSeq: 241 },
        startCursor: { seq: 200 },
        endCursor: { seq: 240 },
        hasOlder: true,
        entries: [
          makeTimelineEntry(200, "latest 200", "user_message"),
          makeTimelineEntry(240, "latest 240", "user_message"),
        ],
      },
    });

    expect(result.commit).toBe("apply");
    expect(getUserTexts(result.tail)).toEqual(["latest 200", "latest 240"]);
    expect(result.cursor).toEqual({ epoch: "epoch-1", startSeq: 200, endSeq: 240 });
    expect(result.sideEffects).toEqual([{ type: "flush_pending_updates" }]);
  });

  it("reconciles in-flight live rows and an unresolved submission during gap replacement", () => {
    const unresolved = makeSubmittedUserMessage("unresolved prompt", "client-unresolved");
    const coveredLive: StreamItem = {
      ...makeAssistantItem("covered live", "covered-live"),
      timelineCursor: { epoch: "epoch-1", seq: 235 },
    };
    const newerLive: StreamItem = {
      ...makeAssistantItem("newer live", "newer-live"),
      timelineCursor: { epoch: "epoch-1", seq: 245 },
    };

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [makeAssistantItem("stale history", "stale-history"), unresolved],
      currentHead: [coveredLive, newerLive],
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 40 },
      payload: {
        ...baseTimelineInput.payload,
        direction: "tail",
        window: { minSeq: 1, maxSeq: 240, nextSeq: 241 },
        startCursor: { seq: 200 },
        endCursor: { seq: 240 },
        hasOlder: true,
        entries: [makeTimelineEntry(240, "canonical tail")],
      },
    });

    expect(getAssistantTexts(result.tail)).toEqual(["canonical tail"]);
    expect(getUserTexts(result.tail)).toEqual(["unresolved prompt"]);
    expect(result.head).toEqual([newerLive]);
  });

  it("replaces destructively when a resume tail has a new epoch", () => {
    const acknowledged: StreamItem = {
      ...makeSubmittedUserMessage("acknowledged old prompt", "client-acknowledged"),
      messageId: "provider-acknowledged",
    };
    const sending = makeSubmittedUserMessage("still sending", "client-sending");

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [acknowledged, sending],
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 40 },
      sendingClientMessageIds: ["client-sending"],
      payload: {
        ...baseTimelineInput.payload,
        direction: "tail",
        epoch: "epoch-2",
        window: { minSeq: 1, maxSeq: 1, nextSeq: 2 },
        startCursor: { seq: 1 },
        endCursor: { seq: 1 },
        entries: [makeTimelineEntry(1, "new epoch")],
      },
    });

    expect(getAssistantTexts(result.tail)).toEqual(["new epoch"]);
    expect(getUserTexts(result.tail)).toEqual(["still sending"]);
    expect(result.cursor).toEqual({ epoch: "epoch-2", startSeq: 1, endSeq: 1 });
  });

  it("replaces destructively when the same epoch rewinds behind the local cursor", () => {
    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [makeAssistantItem("future history", "future-history")],
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 40 },
      payload: {
        ...baseTimelineInput.payload,
        direction: "tail",
        window: { minSeq: 1, maxSeq: 10, nextSeq: 11 },
        startCursor: { seq: 1 },
        endCursor: { seq: 10 },
        entries: [makeTimelineEntry(10, "rewound history")],
      },
    });

    expect(getAssistantTexts(result.tail)).toEqual(["rewound history"]);
    expect(result.cursor).toEqual({ epoch: "epoch-1", startSeq: 1, endSeq: 10 });
  });

  it("preserves the canonical end cursor on a projected assistant message", () => {
    const result = processTimelineResponse({
      ...baseTimelineInput,
      payload: {
        ...baseTimelineInput.payload,
        epoch: "timeline-1",
        entries: [makeTimelineEntry(40, "[System Error] failed", "assistant_message", 42)],
      },
    });

    expect(result.tail).toEqual([
      expect.objectContaining({
        kind: "assistant_message",
        text: "[System Error] failed",
        timelineCursor: { epoch: "timeline-1", seq: 42 },
      }),
    ]);
  });

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

  it("keeps a live assistant and submitted head prompt in one lane during replacement", () => {
    const submitted = makeSubmittedUserMessage("New prompt", "client-new-prompt");
    const liveAssistant = {
      ...makeAssistantItem("Live answer", "answer-1"),
      messageId: "answer-1",
    };

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [],
      currentHead: [liveAssistant, submitted],
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 1 },
      sendingClientMessageIds: [],
      payload: {
        ...baseTimelineInput.payload,
        reset: true,
        epoch: "epoch-1",
        startCursor: { seq: 1 },
        endCursor: { seq: 1 },
        entries: [
          {
            ...makeTimelineEntry(1, "Live", "assistant_message"),
            item: {
              type: "assistant_message",
              text: "Live",
              messageId: "answer-1",
            },
          },
        ],
      },
    });

    expect(result.tail).toEqual([]);
    expect(result.head).toEqual([{ ...liveAssistant, text: "Live" }, submitted]);
  });

  it("preserves newer live head items when canonical replacement ends in a tool call", () => {
    const liveThought: StreamItem = {
      kind: "thought",
      id: "live-thought",
      text: "newer reasoning",
      timestamp: new Date(3000),
      status: "loading",
    };
    const liveAssistant = makeAssistantItem("newer answer", "live-answer");

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentHead: [liveThought, liveAssistant],
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 1 },
      payload: {
        ...baseTimelineInput.payload,
        reset: true,
        epoch: "epoch-1",
        startCursor: { seq: 1 },
        endCursor: { seq: 1 },
        entries: [
          makeToolCallTimelineEntry(1, "canonical-call", "completed", {
            type: "read",
            filePath: "/tmp/older.ts",
          }),
        ],
      },
    });

    expect(result.tail.map((item) => item.kind)).toEqual(["tool_call"]);
    expect(result.head).toEqual([liveThought, liveAssistant]);
  });

  it("keeps a newer live tool completion when bootstrap contains the running call", () => {
    const callId = "toolu_live_completion";
    const liveCompletion = hydrateStreamState(
      [
        {
          event: {
            type: "timeline",
            provider: "claude",
            item: makeToolCallTimelineEntry(2, callId, "completed", {
              type: "read",
              filePath: "/tmp/example.ts",
            }).item,
          } as AgentStreamEventPayload,
          timestamp: new Date(2000),
          timelineCursor: { epoch: "epoch-1", seq: 2 },
        },
      ],
      { source: "canonical" },
    );

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentHead: liveCompletion,
      isInitializing: true,
      hasActiveInitDeferred: true,
      payload: {
        ...baseTimelineInput.payload,
        direction: "tail",
        reset: false,
        epoch: "epoch-1",
        startCursor: { seq: 1 },
        endCursor: { seq: 1 },
        entries: [
          makeToolCallTimelineEntry(1, callId, "running", {
            type: "unknown",
            input: { file_path: "/tmp/example.ts" },
            output: null,
          }),
        ],
      },
    });

    expect(getAgentToolCalls([...result.tail, ...result.head])).toEqual([
      expect.objectContaining({
        timelineCursor: { epoch: "epoch-1", seq: 2 },
        payload: expect.objectContaining({
          data: expect.objectContaining({ callId, status: "completed" }),
        }),
      }),
    ]);
  });

  it("keeps one newer todo state when bootstrap contains its older state", () => {
    const liveTodo = hydrateStreamState(
      [
        {
          event: {
            type: "timeline",
            provider: "codex",
            item: {
              type: "todo",
              items: [{ text: "Verify hydration", completed: true }],
            },
          } as AgentStreamEventPayload,
          timestamp: new Date(2000),
          timelineCursor: { epoch: "epoch-1", seq: 2 },
        },
      ],
      { source: "canonical" },
    );

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentHead: liveTodo,
      isInitializing: true,
      hasActiveInitDeferred: true,
      payload: {
        ...baseTimelineInput.payload,
        direction: "tail",
        reset: false,
        epoch: "epoch-1",
        startCursor: { seq: 1 },
        endCursor: { seq: 1 },
        entries: [
          {
            seqStart: 1,
            seqEnd: 1,
            provider: "codex",
            item: {
              type: "todo",
              items: [{ text: "Verify hydration", completed: false }],
            },
            timestamp: new Date(1000).toISOString(),
          },
        ],
      },
    });

    expect([...result.tail, ...result.head].filter((item) => item.kind === "todo_list")).toEqual([
      expect.objectContaining({
        timelineCursor: { epoch: "epoch-1", seq: 2 },
        items: [{ text: "Verify hydration", completed: true }],
      }),
    ]);
  });

  it("keeps one completed compaction when bootstrap contains its loading state", () => {
    const liveCompaction = hydrateStreamState(
      [
        {
          event: {
            type: "timeline",
            provider: "codex",
            item: { type: "compaction", status: "completed", trigger: "auto", preTokens: 1200 },
          } as AgentStreamEventPayload,
          timestamp: new Date(2000),
          timelineCursor: { epoch: "epoch-1", seq: 2 },
        },
      ],
      { source: "canonical" },
    );

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentHead: liveCompaction,
      isInitializing: true,
      hasActiveInitDeferred: true,
      payload: {
        ...baseTimelineInput.payload,
        direction: "tail",
        reset: false,
        epoch: "epoch-1",
        startCursor: { seq: 1 },
        endCursor: { seq: 1 },
        entries: [
          {
            seqStart: 1,
            seqEnd: 1,
            provider: "codex",
            item: { type: "compaction", status: "loading", trigger: "auto" },
            timestamp: new Date(1000).toISOString(),
          },
        ],
      },
    });

    expect([...result.tail, ...result.head].filter((item) => item.kind === "compaction")).toEqual([
      expect.objectContaining({
        timelineCursor: { epoch: "epoch-1", seq: 2 },
        status: "completed",
        trigger: "auto",
        preTokens: 1200,
      }),
    ]);
  });

  it("replaces a painted replica with an empty authoritative timeline", () => {
    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [makeAssistantItem("painted replica")],
      isInitializing: true,
      hasActiveInitDeferred: true,
      payload: {
        ...baseTimelineInput.payload,
        direction: "tail",
        startCursor: null,
        endCursor: null,
        entries: [],
        hasOlder: false,
      },
    });

    expect(result.tail).toEqual([]);
    expect(result.cursor).toBeNull();
  });

  it("keeps a newer live assistant continuation when bootstrap ends on the same message", () => {
    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [makeAssistantItem("painted replica")],
      currentHead: [
        {
          kind: "assistant_message",
          id: "assistant-live",
          messageId: "assistant-live",
          text: " continuation",
          timestamp: new Date(2001),
          timelineCursor: { epoch: "epoch-1", seq: 101 },
        },
      ],
      isInitializing: true,
      hasActiveInitDeferred: true,
      payload: {
        ...baseTimelineInput.payload,
        direction: "tail",
        startCursor: { seq: 61 },
        endCursor: { seq: 100 },
        entries: [
          {
            ...makeTimelineEntry(100, "canonical prefix"),
            item: {
              type: "assistant_message",
              text: "canonical prefix",
              messageId: "assistant-live",
            },
          },
        ],
      },
    });

    const assistants = [...result.tail, ...result.head].filter(
      (item) => item.kind === "assistant_message",
    );
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.text).toBe("canonical prefix continuation");
    expect(assistants[0]?.timelineCursor).toEqual({ epoch: "epoch-1", seq: 101 });
  });

  it("keeps assistant segments separate when a live tool sits between them", () => {
    const messageId = "assistant-with-tool";
    const liveTool = hydrateStreamState(
      [
        {
          event: {
            type: "timeline",
            provider: "claude",
            item: makeToolCallTimelineEntry(101, "tool-between-segments", "completed", {
              type: "read",
              filePath: "/tmp/example.ts",
            }).item,
          } as AgentStreamEventPayload,
          timestamp: new Date(2101),
          timelineCursor: { epoch: "epoch-1", seq: 101 },
        },
        {
          event: makeAssistantTimelineEvent("after tool", messageId),
          timestamp: new Date(2102),
          timelineCursor: { epoch: "epoch-1", seq: 102 },
        },
      ],
      { source: "canonical" },
    );

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [makeAssistantItem("painted replica")],
      currentHead: liveTool,
      isInitializing: true,
      hasActiveInitDeferred: true,
      payload: {
        ...baseTimelineInput.payload,
        direction: "tail",
        startCursor: { seq: 61 },
        endCursor: { seq: 100 },
        entries: [
          {
            ...makeTimelineEntry(100, "before tool"),
            item: {
              type: "assistant_message",
              text: "before tool",
              messageId,
            },
          },
        ],
      },
    });

    expect([...result.tail, ...result.head].map((item) => item.kind)).toEqual([
      "assistant_message",
      "tool_call",
      "assistant_message",
    ]);
    expect(getAssistantTexts([...result.tail, ...result.head])).toEqual([
      "before tool",
      "after tool",
    ]);
  });

  it("keeps a newer live assistant continuation without a provider message ID", () => {
    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [makeAssistantItem("painted replica")],
      currentHead: [
        {
          kind: "assistant_message",
          id: "assistant-live",
          text: "canonical prefix continuation",
          timestamp: new Date(2001),
          timelineCursor: { epoch: "epoch-1", seq: 101 },
        },
      ],
      isInitializing: true,
      hasActiveInitDeferred: true,
      payload: {
        ...baseTimelineInput.payload,
        direction: "tail",
        startCursor: { seq: 61 },
        endCursor: { seq: 100 },
        entries: [makeTimelineEntry(100, "canonical prefix")],
      },
    });

    const assistants = [...result.tail, ...result.head].filter(
      (item) => item.kind === "assistant_message",
    );
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.text).toBe("canonical prefix continuation");
    expect(assistants[0]?.timelineCursor).toEqual({ epoch: "epoch-1", seq: 101 });
  });

  it("keeps a canonical live user row newer than the bootstrap page", () => {
    const live = processAgentStreamEvent({
      ...baseStreamInput,
      event: {
        type: "timeline",
        provider: "claude",
        item: {
          type: "user_message",
          text: "remote live prompt",
          clientMessageId: "remote-client-message",
        },
      },
      seq: 101,
      epoch: "epoch-1",
      currentTail: [makeAssistantItem("painted replica")],
      hasAuthoritativeBaseline: false,
    });
    expect(live.head[0]).toMatchObject({
      kind: "user_message",
      timelineCursor: { epoch: "epoch-1", seq: 101 },
    });

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: live.tail,
      currentHead: live.head,
      isInitializing: true,
      hasActiveInitDeferred: true,
      payload: {
        ...baseTimelineInput.payload,
        direction: "tail",
        startCursor: { seq: 61 },
        endCursor: { seq: 100 },
        entries: [makeTimelineEntry(100, "canonical answer")],
      },
    });

    expect(getUserTexts(result.head)).toEqual(["remote live prompt"]);
  });

  it("keeps a provider-acknowledged painted-tail prompt newer than the bootstrap page", () => {
    const submitted = makeSubmittedUserMessage("submitted before bootstrap", "client-message-1");
    const live = processAgentStreamEvent({
      ...baseStreamInput,
      event: {
        type: "timeline",
        provider: "claude",
        item: {
          type: "user_message",
          text: "canonical presentation",
          clientMessageId: "client-message-1",
          messageId: "provider-message-1",
        },
      },
      seq: 51,
      epoch: "epoch-1",
      currentTail: [makeAssistantItem("painted replica"), submitted],
      currentCursor: undefined,
      hasAuthoritativeBaseline: false,
    });

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: live.tail,
      currentHead: live.head,
      sendingClientMessageIds: [],
      isInitializing: true,
      hasActiveInitDeferred: true,
      payload: {
        ...baseTimelineInput.payload,
        direction: "tail",
        startCursor: { seq: 11 },
        endCursor: { seq: 50 },
        entries: [makeTimelineEntry(50, "canonical answer")],
      },
    });

    expect(getUserTexts([...result.tail, ...result.head])).toEqual(["submitted before bootstrap"]);
    expect(result.head[0]).toMatchObject({
      kind: "user_message",
      clientMessageId: "client-message-1",
      messageId: "provider-message-1",
      timelineCursor: { epoch: "epoch-1", seq: 51 },
    });
  });

  it("does not duplicate a live row already covered by the bootstrap page", () => {
    const live = processAgentStreamEvent({
      ...baseStreamInput,
      event: makeTimelineEvent("thinking", "reasoning"),
      seq: 100,
      epoch: "epoch-1",
      currentTail: [makeAssistantItem("painted replica")],
      hasAuthoritativeBaseline: false,
    });

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: live.tail,
      currentHead: live.head,
      isInitializing: true,
      hasActiveInitDeferred: true,
      payload: {
        ...baseTimelineInput.payload,
        direction: "tail",
        startCursor: { seq: 61 },
        endCursor: { seq: 100 },
        entries: [makeTimelineEntry(100, "thinking", "reasoning")],
      },
    });

    expect([...result.tail, ...result.head].filter((item) => item.kind === "thought")).toHaveLength(
      1,
    );
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

  it("reconciles a submitted user message during tail replacement", () => {
    const image = {
      id: "submitted-image",
      mimeType: "image/png",
      storageType: "web-indexeddb" as const,
      storageKey: "submitted-image",
      createdAt: 1000,
    };
    const attachment = {
      type: "text" as const,
      mimeType: "text/plain" as const,
      text: "attached context",
      title: "context.txt",
    };
    const submitted = createUserMessage({
      clientMessageId: "submitted-create-user",
      text: "Analyze this",
      timestamp: new Date(1000),
      images: [image],
      attachments: [attachment],
    });

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [submitted],
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
              clientMessageId: "submitted-create-user",
            },
          },
        ],
      },
    });

    const userMessages = result.tail.filter((item) => item.kind === "user_message");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]).toMatchObject({
      id: "submitted-create-user",
      clientMessageId: "submitted-create-user",
      messageId: "canonical-create-user",
      text: "Analyze this",
      timestamp: new Date(1000),
      images: [image],
      attachments: [attachment],
    });

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
              clientMessageId: "submitted-create-user",
            },
          },
        ],
      },
    });

    expect(repeated.tail.filter((item) => item.kind === "user_message")).toEqual(userMessages);
  });

  it("keeps an unmatched submitted user message during tail replacement", () => {
    const submitted = makeSubmittedUserMessage("still sending", "submitted-unmatched");

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [submitted],
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 1 },
      sendingClientMessageIds: ["submitted-unmatched"],
      payload: {
        ...baseTimelineInput.payload,
        reset: true,
        epoch: "epoch-2",
        entries: [],
      },
    });

    expect(result.tail).toEqual([submitted]);
  });

  it("keeps every unresolved submission during replacement", () => {
    const first = makeSubmittedUserMessage("first pending", "client-first");
    const second = makeSubmittedUserMessage("second pending", "client-second");

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [first, second],
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 1 },
      sendingClientMessageIds: ["client-first", "client-second"],
      payload: {
        ...baseTimelineInput.payload,
        reset: true,
        epoch: "epoch-2",
        entries: [],
      },
    });

    expect(result.tail).toEqual([first, second]);
  });

  it("keeps an unreconciled local presentation through same-epoch replacement", () => {
    const image = {
      id: "local-image",
      mimeType: "image/png",
      storageType: "web-indexeddb" as const,
      storageKey: "local-image",
      createdAt: 1000,
    };
    const attachment = {
      type: "text" as const,
      mimeType: "text/plain" as const,
      text: "attached context",
      title: "context.txt",
    };
    const local = createUserMessage({
      clientMessageId: "client-local-only",
      text: "provider may not echo this",
      timestamp: new Date(1000),
      images: [image],
      attachments: [attachment],
    });

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [local],
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 1 },
      sendingClientMessageIds: [],
      payload: {
        ...baseTimelineInput.payload,
        reset: true,
        epoch: "epoch-1",
        startCursor: { seq: 2 },
        endCursor: { seq: 2 },
        entries: [makeTimelineEntry(2, "another client's response")],
      },
    });

    expect(result.tail).toEqual([
      expect.objectContaining({
        kind: "assistant_message",
        text: "another client's response",
      }),
      local,
    ]);
  });

  it("keeps an unreconciled local presentation during non-reset bootstrap", () => {
    const local = makeSubmittedUserMessage("first prompt", "client-first-prompt");

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [local],
      isInitializing: true,
      hasActiveInitDeferred: true,
      payload: {
        ...baseTimelineInput.payload,
        direction: "tail",
      },
    });

    expect(result.tail).toEqual([local]);
  });

  it("drops an unreconciled local row omitted by a known epoch change", () => {
    const local = createUserMessage({
      clientMessageId: "client-prior-epoch",
      text: "prior prompt",
      timestamp: new Date(1000),
    });

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [local],
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 1 },
      sendingClientMessageIds: [],
      payload: {
        ...baseTimelineInput.payload,
        reset: true,
        epoch: "epoch-2",
        entries: [],
      },
    });

    expect(result.tail).toEqual([]);
  });

  it("drops an unreconciled head row omitted by a known epoch change", () => {
    const local = makeSubmittedUserMessage("prior prompt", "client-prior-epoch");

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentHead: [local],
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 1 },
      sendingClientMessageIds: [],
      payload: {
        ...baseTimelineInput.payload,
        reset: true,
        epoch: "epoch-2",
        entries: [],
      },
    });

    expect(result.head).toEqual([]);
  });

  it("keeps an active head submission across a known epoch change", () => {
    const local = makeSubmittedUserMessage("pending prompt", "client-pending");

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentHead: [local],
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 1 },
      sendingClientMessageIds: ["client-pending"],
      payload: {
        ...baseTimelineInput.payload,
        reset: true,
        epoch: "epoch-2",
        entries: [],
      },
    });

    expect(result.head).toEqual([local]);
  });

  it("keeps an unmatched submission after the canonical replacement range", () => {
    const unmatched = makeSubmittedUserMessage("first submission", "client-first");
    const acknowledged: StreamItem[] = [
      {
        kind: "user_message",
        id: "provider-second",
        clientMessageId: "client-second",
        text: "second submission",
        timestamp: new Date(2000),
      },
      {
        kind: "user_message",
        id: "provider-third",
        clientMessageId: "client-third",
        text: "third submission",
        timestamp: new Date(3000),
      },
    ];

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [unmatched, ...acknowledged],
      sendingClientMessageIds: ["client-first"],
      payload: {
        ...baseTimelineInput.payload,
        reset: true,
        startCursor: { seq: 2 },
        endCursor: { seq: 4 },
        entries: [
          {
            ...makeTimelineEntry(2, "second submission", "user_message"),
            item: {
              type: "user_message",
              text: "second submission",
              messageId: "provider-second",
              clientMessageId: "client-second",
            },
          },
          {
            ...makeTimelineEntry(3, "third submission", "user_message"),
            item: {
              type: "user_message",
              text: "third submission",
              messageId: "provider-third",
              clientMessageId: "client-third",
            },
          },
          {
            ...makeTimelineEntry(4, "response to canonical submissions"),
            item: {
              type: "assistant_message",
              text: "response to canonical submissions",
              messageId: "assistant-response",
            },
          },
        ],
      },
    });

    expect(
      result.tail.map((item) => ({
        kind: item.kind,
        id: item.id,
        text: "text" in item ? item.text : undefined,
      })),
    ).toEqual([
      { kind: "user_message", id: "provider-second", text: "second submission" },
      { kind: "user_message", id: "provider-third", text: "third submission" },
      {
        kind: "assistant_message",
        id: "assistant-response",
        text: "response to canonical submissions",
      },
      { kind: "user_message", id: "client-first", text: "first submission" },
    ]);
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

  it("reconciles a legacy canonical user message by content during an after-page response", () => {
    const existingCursor: TimelineCursor = {
      epoch: "epoch-1",
      startSeq: 1,
      endSeq: 1,
    };
    const submitted = makeSubmittedUserMessage("sent while catching up", "submitted-after");

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [submitted],
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
    expect(userMessages[0]).toMatchObject({
      id: "submitted-after",
      clientMessageId: "submitted-after",
      messageId: "canonical-after",
    });
  });

  it("reconciles a submitted user message by client message id", () => {
    const submitted = makeSubmittedUserMessage("local presentation", "client-message");

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [submitted],
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 1 },
      payload: {
        ...baseTimelineInput.payload,
        epoch: "epoch-1",
        entries: [
          {
            ...makeTimelineEntry(2, "provider presentation", "user_message"),
            item: {
              type: "user_message",
              text: "provider presentation",
              messageId: "provider-message",
              clientMessageId: "client-message",
            },
          },
        ],
      },
    });

    const userMessages = result.tail.filter((item) => item.kind === "user_message");
    expect(userMessages).toEqual([
      expect.objectContaining({
        id: "client-message",
        clientMessageId: "client-message",
        messageId: "provider-message",
        text: "local presentation",
      }),
    ]);
    expect(result.acknowledgedClientMessageIds).toEqual(["client-message"]);
  });

  it("acknowledges a submitted prompt from an otherwise unchanged tail snapshot", () => {
    const clientMessageId = "client-message";
    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [makeSubmittedUserMessage("local presentation", clientMessageId)],
      currentCursor: { epoch: "epoch-1", startSeq: 2, endSeq: 4 },
      sendingClientMessageIds: [clientMessageId],
      payload: {
        ...baseTimelineInput.payload,
        direction: "tail",
        window: { minSeq: 1, maxSeq: 4, nextSeq: 5 },
        startCursor: { seq: 1 },
        endCursor: { seq: 4 },
        entries: [
          {
            ...makeTimelineEntry(1, "provider presentation", "user_message"),
            item: {
              type: "user_message",
              text: "provider presentation",
              messageId: clientMessageId,
              clientMessageId,
            },
          },
          {
            ...makeTimelineEntry(2, "assistant response", "assistant_message", 4),
            item: {
              type: "assistant_message",
              text: "assistant response",
              messageId: "assistant-message",
            },
          },
        ],
      },
    });

    expect(result.acknowledgedClientMessageIds).toEqual([clientMessageId]);
  });

  it("reconciles multiple submitted user messages in canonical order", () => {
    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [
        makeSubmittedUserMessage("first prompt", "submitted-first"),
        makeSubmittedUserMessage("second prompt", "submitted-second"),
      ],
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 1 },
      payload: {
        ...baseTimelineInput.payload,
        epoch: "epoch-1",
        startCursor: { seq: 2 },
        endCursor: { seq: 3 },
        entries: [
          {
            ...makeTimelineEntry(2, "first prompt", "user_message"),
            item: { type: "user_message", text: "first prompt", messageId: "submitted-first" },
          },
          {
            ...makeTimelineEntry(3, "second prompt", "user_message"),
            item: {
              type: "user_message",
              text: "second prompt",
              messageId: "submitted-second",
            },
          },
        ],
      },
    });

    expect(
      result.tail
        .filter((item) => item.kind === "user_message")
        .map((item) => ({ id: item.id, text: item.text, messageId: item.messageId })),
    ).toEqual([
      { id: "submitted-first", text: "first prompt", messageId: "submitted-first" },
      { id: "submitted-second", text: "second prompt", messageId: "submitted-second" },
    ]);
  });

  it("keeps a tail submitted prompt before a reconciled live assistant head", () => {
    const prompt = makeSubmittedUserMessage("new prompt", "submitted-new-prompt");

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [prompt],
      currentHead: [
        {
          ...makeAssistantItem("Hel", "answer-1"),
          messageId: "answer-1",
        },
      ],
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 2 },
      payload: {
        ...baseTimelineInput.payload,
        direction: "after",
        epoch: "epoch-1",
        startCursor: { seq: 3 },
        endCursor: { seq: 3 },
        entries: [
          {
            ...makeTimelineEntry(2, "Hello", "assistant_message", 3),
            sourceSeqRanges: [{ startSeq: 2, endSeq: 3 }],
            item: {
              type: "assistant_message",
              text: "Hello",
              messageId: "answer-1",
            },
          },
        ],
      },
    });

    expect(
      [...result.tail, ...result.head]
        .filter((item) => item.kind === "assistant_message" || item.kind === "user_message")
        .map((item) => item.text),
    ).toEqual(["new prompt", "Hello"]);
  });

  it("keeps a tail submitted prompt before a live head flushed by catch-up", () => {
    const prompt = makeSubmittedUserMessage("new prompt", "submitted-new-prompt");

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [prompt],
      currentHead: [
        {
          ...makeAssistantItem("Live response", "answer-1"),
          messageId: "answer-1",
        },
      ],
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 2 },
      payload: {
        ...baseTimelineInput.payload,
        direction: "after",
        epoch: "epoch-1",
        startCursor: { seq: 3 },
        endCursor: { seq: 3 },
        entries: [
          makeToolCallTimelineEntry(3, "call-1", "running", {
            type: "read",
            filePath: "/tmp/example.ts",
          }),
        ],
      },
    });

    expect(
      [...result.tail, ...result.head]
        .filter((item) => item.kind === "assistant_message" || item.kind === "user_message")
        .map((item) => item.text),
    ).toEqual(["new prompt", "Live response"]);
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

  it("does not replay an assistant prefix when catch-up completes an earlier tool call", () => {
    const live = processAgentStreamEvents({
      events: [
        makeStreamReducerEvent(makeToolCallTimelineEvent("call-1"), 1),
        makeStreamReducerEvent(makeAssistantTimelineEvent("Hel", "answer-1"), 2),
      ],
      currentTail: [],
      currentHead: [],
      currentCursor: undefined,
    });

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: live.tail,
      currentHead: live.head,
      currentCursor: live.cursor ?? undefined,
      payload: {
        ...baseTimelineInput.payload,
        epoch: "epoch-1",
        startCursor: { seq: 3 },
        endCursor: { seq: 4 },
        entries: [
          {
            ...makeToolCallTimelineEntry(1, "call-1", "completed", {
              type: "read",
              filePath: "/tmp/example.ts",
            }),
            seqEnd: 4,
            sourceSeqRanges: [
              { startSeq: 1, endSeq: 1 },
              { startSeq: 4, endSeq: 4 },
            ],
          },
          {
            ...makeTimelineEntry(2, "Hello", "assistant_message", 3),
            sourceSeqRanges: [{ startSeq: 2, endSeq: 3 }],
            item: {
              type: "assistant_message",
              text: "Hello",
              messageId: "answer-1",
            },
          },
        ],
      },
    });

    expect(getAssistantTexts([...result.tail, ...result.head])).toEqual(["Hello"]);
  });

  it("reconciles an identified projection with an overlapping anonymous live prefix", () => {
    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentHead: [makeAssistantItem("Hel")],
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 2 },
      payload: {
        ...baseTimelineInput.payload,
        epoch: "epoch-1",
        startCursor: { seq: 3 },
        endCursor: { seq: 3 },
        entries: [
          {
            ...makeTimelineEntry(2, "Hello", "assistant_message", 3),
            sourceSeqRanges: [{ startSeq: 2, endSeq: 3 }],
            item: {
              type: "assistant_message",
              text: "Hello",
              messageId: "answer-1",
            },
          },
        ],
      },
    });

    const assistants = [...result.tail, ...result.head].filter(
      (item) => item.kind === "assistant_message",
    );
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ text: "Hello", messageId: "answer-1" });
  });

  it("replaces every promoted assistant block when reconciling a projected message", () => {
    const live = processAgentStreamEvents({
      events: [makeStreamReducerEvent(makeAssistantTimelineEvent("First paragraph.\n\nSec"), 2)],
      currentTail: [],
      currentHead: [],
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 1 },
    });
    expect(getAssistantTexts(live.tail)).toHaveLength(1);
    expect(getAssistantTexts(live.head)).toHaveLength(1);

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: live.tail,
      currentHead: live.head,
      currentCursor: live.cursor ?? undefined,
      payload: {
        ...baseTimelineInput.payload,
        direction: "after",
        epoch: "epoch-1",
        startCursor: { seq: 3 },
        endCursor: { seq: 3 },
        entries: [
          {
            ...makeTimelineEntry(
              2,
              "First paragraph.\n\nSecond paragraph.",
              "assistant_message",
              3,
            ),
            sourceSeqRanges: [{ startSeq: 2, endSeq: 3 }],
            item: {
              type: "assistant_message",
              text: "First paragraph.\n\nSecond paragraph.",
            },
          },
        ],
      },
    });

    expect(getAssistantTexts([...result.tail, ...result.head])).toEqual([
      "First paragraph.\n\nSecond paragraph.",
    ]);
  });

  it("does not replay a reasoning prefix when catch-up completes an earlier tool call", () => {
    const live = processAgentStreamEvents({
      events: [
        makeStreamReducerEvent(makeToolCallTimelineEvent("call-1"), 1),
        makeStreamReducerEvent(makeTimelineEvent("Thi", "reasoning"), 2),
      ],
      currentTail: [],
      currentHead: [],
      currentCursor: undefined,
    });

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: live.tail,
      currentHead: live.head,
      currentCursor: live.cursor ?? undefined,
      payload: {
        ...baseTimelineInput.payload,
        epoch: "epoch-1",
        startCursor: { seq: 3 },
        endCursor: { seq: 4 },
        entries: [
          {
            ...makeToolCallTimelineEntry(1, "call-1", "completed", {
              type: "read",
              filePath: "/tmp/example.ts",
            }),
            seqEnd: 4,
            sourceSeqRanges: [
              { startSeq: 1, endSeq: 1 },
              { startSeq: 4, endSeq: 4 },
            ],
          },
          {
            ...makeTimelineEntry(2, "Thinking", "reasoning", 3),
            sourceSeqRanges: [{ startSeq: 2, endSeq: 3 }],
          },
        ],
      },
    });

    const thoughts = [...result.tail, ...result.head].filter((item) => item.kind === "thought");
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0]?.text).toBe("Thinking");
  });

  it("does not move a submitted prompt when catch-up history arrives", () => {
    const prompt = makeSubmittedUserMessage("New prompt", "new-prompt");

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [makeAssistantItem("Earlier answer", "earlier-answer"), prompt],
      currentHead: [],
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 2 },
      payload: {
        ...baseTimelineInput.payload,
        epoch: "epoch-1",
        startCursor: { seq: 3 },
        endCursor: { seq: 3 },
        entries: [makeTimelineEntry(3, "Missed answer")],
      },
    });

    expect(
      [...result.tail, ...result.head]
        .filter((item) => item.kind === "assistant_message" || item.kind === "user_message")
        .map((item) => item.text),
    ).toEqual(["Earlier answer", "New prompt", "Missed answer"]);
  });

  it("does not move an unmatched head prompt when catch-up history arrives", () => {
    const prompt = makeSubmittedUserMessage("New prompt", "new-prompt");

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [],
      currentHead: [makeAssistantItem("Live answer", "live-answer"), prompt],
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 2 },
      payload: {
        ...baseTimelineInput.payload,
        epoch: "epoch-1",
        startCursor: { seq: 3 },
        endCursor: { seq: 3 },
        entries: [
          makeToolCallTimelineEntry(3, "missed-call", "completed", {
            type: "read",
            filePath: "/tmp/missed.ts",
          }),
        ],
      },
    });

    expect([...result.tail, ...result.head].map((item) => item.kind)).toEqual([
      "assistant_message",
      "user_message",
      "tool_call",
    ]);
  });

  it("moves an acknowledged head prompt to its catch-up sequence position", () => {
    const prompt = makeSubmittedUserMessage("New prompt", "new-prompt");

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [],
      currentHead: [makeAssistantItem("Live answer", "live-answer"), prompt],
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 2 },
      payload: {
        ...baseTimelineInput.payload,
        epoch: "epoch-1",
        startCursor: { seq: 3 },
        endCursor: { seq: 4 },
        entries: [
          makeToolCallTimelineEntry(3, "missed-call", "completed", {
            type: "read",
            filePath: "/tmp/missed.ts",
          }),
          {
            ...makeTimelineEntry(4, "New prompt", "user_message"),
            item: {
              type: "user_message",
              text: "New prompt",
              messageId: "new-prompt",
            },
          },
        ],
      },
    });

    expect([...result.tail, ...result.head].map((item) => item.kind)).toEqual([
      "assistant_message",
      "tool_call",
      "user_message",
    ]);
    expect(
      [...result.tail, ...result.head]
        .filter((item) => item.kind === "user_message")
        .map((item) => item.clientMessageId),
    ).toEqual(["new-prompt"]);
  });

  it("does not move a prompt around unrelated catch-up history", () => {
    const prompt = makeSubmittedUserMessage("New prompt", "new-prompt");

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [makeAssistantItem("Earlier answer", "earlier-answer"), prompt],
      currentHead: [
        {
          ...makeAssistantItem("Live response", "live-response"),
          messageId: "live-response",
        },
      ],
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 2 },
      payload: {
        ...baseTimelineInput.payload,
        epoch: "epoch-1",
        startCursor: { seq: 3 },
        endCursor: { seq: 4 },
        entries: [
          {
            ...makeTimelineEntry(3, "Missed answer"),
            item: {
              type: "assistant_message",
              text: "Missed answer",
              messageId: "missed-answer",
            },
          },
          {
            ...makeTimelineEntry(4, "Remote prompt", "user_message"),
            item: {
              type: "user_message",
              text: "Remote prompt",
              messageId: "remote-prompt",
            },
          },
        ],
      },
    });

    expect(
      [...result.tail, ...result.head]
        .filter((item) => item.kind === "assistant_message" || item.kind === "user_message")
        .map((item) => item.text),
    ).toEqual(["Earlier answer", "New prompt", "Live response", "Missed answer", "Remote prompt"]);
  });

  it("does not move a prompt or its live answer around catch-up history", () => {
    const prompt = makeSubmittedUserMessage("New prompt", "new-prompt");
    const live = processAgentStreamEvents({
      events: [
        makeStreamReducerEvent(
          makeAssistantTimelineEvent("First paragraph.\n\nSecond paragraph", "live-response"),
          2,
        ),
      ],
      currentTail: [prompt],
      currentHead: [],
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 1 },
    });

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: live.tail,
      currentHead: live.head,
      currentCursor: live.cursor ?? undefined,
      payload: {
        ...baseTimelineInput.payload,
        epoch: "epoch-1",
        startCursor: { seq: 3 },
        endCursor: { seq: 3 },
        entries: [
          {
            ...makeTimelineEntry(3, "Missed answer"),
            item: {
              type: "assistant_message",
              text: "Missed answer",
              messageId: "missed-answer",
            },
          },
        ],
      },
    });

    expect(
      [...result.tail, ...result.head]
        .filter((item) => item.kind === "assistant_message" || item.kind === "user_message")
        .map((item) => item.text),
    ).toEqual(["New prompt", "First paragraph.", "Second paragraph", "Missed answer"]);
  });

  it("does not move a prompt or its live answer around catch-up tool history", () => {
    const prompt = makeSubmittedUserMessage("New prompt", "new-prompt");
    const live = processAgentStreamEvents({
      events: [
        makeStreamReducerEvent(
          makeAssistantTimelineEvent("First paragraph.\n\nSecond paragraph", "live-response"),
          2,
        ),
      ],
      currentTail: [prompt],
      currentHead: [],
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 1 },
    });

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: live.tail,
      currentHead: live.head,
      currentCursor: live.cursor ?? undefined,
      payload: {
        ...baseTimelineInput.payload,
        epoch: "epoch-1",
        startCursor: { seq: 3 },
        endCursor: { seq: 3 },
        entries: [
          makeToolCallTimelineEntry(3, "missed-call", "completed", {
            type: "read",
            filePath: "/tmp/missed.ts",
          }),
        ],
      },
    });

    expect([...result.tail, ...result.head].map((item) => item.kind)).toEqual([
      "user_message",
      "assistant_message",
      "assistant_message",
      "tool_call",
    ]);
  });

  it("never moves submitted messages behind a later assistant response", () => {
    const unmatched = makeSubmittedUserMessage("first submission", "client-first");
    const acknowledged: StreamItem[] = [
      {
        kind: "user_message",
        id: "provider-second",
        clientMessageId: "client-second",
        text: "second submission",
        timestamp: new Date(2000),
      },
      {
        kind: "user_message",
        id: "provider-third",
        clientMessageId: "client-third",
        text: "third submission",
        timestamp: new Date(3000),
      },
    ];

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [unmatched, ...acknowledged],
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 3 },
      payload: {
        ...baseTimelineInput.payload,
        epoch: "epoch-1",
        startCursor: { seq: 4 },
        endCursor: { seq: 4 },
        entries: [
          {
            ...makeTimelineEntry(4, "response to all three submissions"),
            item: {
              type: "assistant_message",
              text: "response to all three submissions",
              messageId: "assistant-response",
            },
          },
        ],
      },
    });

    expect(
      [...result.tail, ...result.head].map((item) => ({
        kind: item.kind,
        id: item.id,
        text: "text" in item ? item.text : undefined,
      })),
    ).toEqual([
      { kind: "user_message", id: "client-first", text: "first submission" },
      { kind: "user_message", id: "provider-second", text: "second submission" },
      { kind: "user_message", id: "provider-third", text: "third submission" },
      {
        kind: "assistant_message",
        id: "assistant-response",
        text: "response to all three submissions",
      },
    ]);
  });

  it("places a local prompt after an earlier remote canonical row", () => {
    const prompt = makeSubmittedUserMessage("Local prompt", "local-prompt");

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [prompt],
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 1 },
      payload: {
        ...baseTimelineInput.payload,
        epoch: "epoch-1",
        startCursor: { seq: 2 },
        endCursor: { seq: 3 },
        entries: [
          {
            ...makeTimelineEntry(2, "Remote prompt", "user_message"),
            item: {
              type: "user_message",
              text: "Remote prompt",
              messageId: "remote-prompt",
            },
          },
          {
            ...makeTimelineEntry(3, "Local prompt", "user_message"),
            item: {
              type: "user_message",
              text: "Local prompt",
              messageId: "local-prompt",
            },
          },
        ],
      },
    });

    expect(
      result.tail.filter((item) => item.kind === "user_message").map((item) => item.text),
    ).toEqual(["Remote prompt", "Local prompt"]);
  });

  it("keeps an unmatched submitted prompt when catch-up contains only a remote user row", () => {
    const prompt = makeSubmittedUserMessage("Local prompt", "local-prompt");

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [prompt],
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 1 },
      payload: {
        ...baseTimelineInput.payload,
        epoch: "epoch-1",
        startCursor: { seq: 2 },
        endCursor: { seq: 2 },
        entries: [
          {
            ...makeTimelineEntry(2, "Remote prompt", "user_message"),
            item: {
              type: "user_message",
              text: "Remote prompt",
              messageId: "remote-prompt",
            },
          },
        ],
      },
    });

    expect(
      result.tail.filter((item) => item.kind === "user_message").map((item) => item.text),
    ).toEqual(["Local prompt", "Remote prompt"]);
  });

  it("does not match equal prompt text when canonical client message ids differ", () => {
    const prompt = makeSubmittedUserMessage("continue", "local-prompt");

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [prompt],
      currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 1 },
      payload: {
        ...baseTimelineInput.payload,
        epoch: "epoch-1",
        startCursor: { seq: 2 },
        endCursor: { seq: 2 },
        entries: [
          {
            ...makeTimelineEntry(2, "continue", "user_message"),
            item: {
              type: "user_message",
              text: "continue",
              messageId: "remote-prompt",
              clientMessageId: "remote-client-prompt",
            },
          },
        ],
      },
    });

    expect(
      result.tail
        .filter((item) => item.kind === "user_message")
        .map((item) => ({ id: item.id, messageId: item.messageId })),
    ).toEqual([
      { id: "local-prompt", messageId: undefined },
      { id: "remote-prompt", messageId: "remote-prompt" },
    ]);
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
    expect(result.older).toBe("unchanged");
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
    expect(result.older).toBe("none");
  });

  it("keeps only projected entries anchored in an older response page", () => {
    const currentTail: StreamItem[] = [
      {
        kind: "user_message",
        id: "current-81",
        text: "current-81",
        timestamp: new Date(81000),
      },
    ];

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail,
      currentCursor: { epoch: "epoch-1", startSeq: 81, endSeq: 100 },
      payload: {
        ...baseTimelineInput.payload,
        direction: "before",
        projection: "projected",
        epoch: "epoch-1",
        startCursor: { seq: 41 },
        endCursor: { seq: 80 },
        hasOlder: true,
        entries: [
          makeTimelineEntry(1, "wide assistant", "assistant_message", 80),
          makeTimelineEntry(50, "owned by this page", "user_message"),
        ],
      },
    });

    expect(getAssistantTexts(result.tail)).toEqual([]);
    expect(getUserTexts(result.tail)).toEqual(["owned by this page", "current-81"]);
    expect(result.cursor).toEqual({ epoch: "epoch-1", startSeq: 41, endSeq: 100 });
    expect(result.older).toBe("available");
  });

  it("advances through an older projected page with no anchored entries", () => {
    const currentTail: StreamItem[] = [
      {
        kind: "user_message",
        id: "current-81",
        text: "current-81",
        timestamp: new Date(81000),
      },
    ];

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail,
      currentCursor: { epoch: "epoch-1", startSeq: 81, endSeq: 100 },
      payload: {
        ...baseTimelineInput.payload,
        direction: "before",
        projection: "projected",
        epoch: "epoch-1",
        startCursor: { seq: 41 },
        endCursor: { seq: 80 },
        hasOlder: true,
        entries: [makeTimelineEntry(1, "wide assistant", "assistant_message", 80)],
      },
    });

    expect(result.tail).toBe(currentTail);
    expect(result.cursor).toEqual({ epoch: "epoch-1", startSeq: 41, endSeq: 100 });
    expect(result.cursorChanged).toBe(true);
    expect(result.older).toBe("available");
  });

  it("gives prepended assistant blocks unique ids across independently hydrated pages", () => {
    const currentTail: StreamItem[] = [
      {
        kind: "user_message",
        id: "current-81",
        text: "current-81",
        timestamp: new Date(81000),
      },
      {
        kind: "assistant_message",
        id: "shared-provider-message",
        messageId: "shared-provider-message",
        text: "newer assistant block",
        timestamp: new Date(82000),
      },
    ];

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail,
      currentCursor: { epoch: "epoch-1", startSeq: 81, endSeq: 100 },
      payload: {
        ...baseTimelineInput.payload,
        direction: "before",
        projection: "projected",
        epoch: "epoch-1",
        startCursor: { seq: 41 },
        endCursor: { seq: 80 },
        hasOlder: true,
        entries: [
          {
            ...makeTimelineEntry(50, "older assistant block"),
            item: {
              type: "assistant_message",
              text: "older assistant block",
              messageId: "shared-provider-message",
            },
          },
        ],
      },
    });

    const assistants = result.tail.filter((item) => item.kind === "assistant_message");
    expect(assistants.map((item) => item.messageId)).toEqual([
      "shared-provider-message",
      "shared-provider-message",
    ]);
    expect(new Set(assistants.map((item) => item.id)).size).toBe(2);
  });

  it("retains the current timeline while merging a disjoint prompt-jump window", () => {
    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [
        {
          kind: "user_message",
          id: "newest",
          text: "newest",
          timestamp: new Date(1000),
          timelineCursor: { epoch: "epoch-1", seq: 100 },
        },
        makeSubmittedUserMessage("pending submission", "pending-submission"),
      ],
      currentCursor: { epoch: "epoch-1", startSeq: 80, endSeq: 100 },
      sendingClientMessageIds: ["pending-submission"],
      payload: {
        ...baseTimelineInput.payload,
        direction: "before",
        mergeWindow: true,
        epoch: "epoch-1",
        startCursor: { seq: 1 },
        endCursor: { seq: 40 },
        hasOlder: false,
        hasNewer: true,
        entries: [makeTimelineEntry(1, "oldest", "user_message")],
      },
    });

    expect(getUserTexts(result.tail)).toEqual(["oldest", "newest", "pending submission"]);
    expect(result.cursor).toEqual({
      epoch: "epoch-1",
      startSeq: 80,
      endSeq: 100,
      retainedRanges: [{ startSeq: 1, endSeq: 40, hasOlder: false }],
    });
    expect(result.older).toBe("none");
    expect(result.sideEffects).not.toContainEqual(expect.objectContaining({ type: "catch_up" }));
  });

  it("keeps live assistant blocks ordered when merging a disjoint prompt-jump window", () => {
    const live = processAgentStreamEvents({
      events: [
        makeStreamReducerEvent(
          makeAssistantTimelineEvent("First paragraph.\n\nSecond", "assistant-1"),
          80,
        ),
        makeStreamReducerEvent(makeAssistantTimelineEvent(" paragraph.", "assistant-1"), 81),
        makeStreamReducerEvent(makeTimelineEvent("newest prompt", "user_message"), 82),
      ],
      currentTail: [],
      currentHead: [],
      currentCursor: undefined,
    });
    expect(getAssistantTexts([...live.tail, ...live.head])).toEqual([
      "First paragraph.",
      "Second paragraph.",
    ]);

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: live.tail,
      currentHead: live.head,
      currentCursor: live.cursor ?? undefined,
      payload: {
        ...baseTimelineInput.payload,
        direction: "before",
        mergeWindow: true,
        epoch: "epoch-1",
        startCursor: { seq: 1 },
        endCursor: { seq: 40 },
        hasOlder: false,
        hasNewer: true,
        entries: [makeTimelineEntry(1, "oldest prompt", "user_message")],
      },
    });

    expect(getAssistantTexts([...result.tail, ...result.head])).toEqual([
      "First paragraph.",
      "Second paragraph.",
    ]);
  });

  it("fills the gap between a retained prompt window and the contiguous tail", () => {
    const currentTail: StreamItem[] = [
      {
        kind: "user_message",
        id: "oldest",
        text: "oldest",
        timestamp: new Date(1000),
        timelineCursor: { epoch: "epoch-1", seq: 1 },
      },
      {
        kind: "user_message",
        id: "newest",
        text: "newest",
        timestamp: new Date(100_000),
        timelineCursor: { epoch: "epoch-1", seq: 100 },
      },
    ];

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail,
      currentCursor: {
        epoch: "epoch-1",
        startSeq: 80,
        endSeq: 100,
        retainedRanges: [{ startSeq: 1, endSeq: 40, hasOlder: false }],
      },
      payload: {
        ...baseTimelineInput.payload,
        direction: "before",
        epoch: "epoch-1",
        startCursor: { seq: 40 },
        endCursor: { seq: 79 },
        hasOlder: true,
        entries: [makeTimelineEntry(50, "bridge", "user_message")],
      },
    });

    expect(getUserTexts(result.tail)).toEqual(["oldest", "bridge", "newest"]);
    expect(result.cursor).toEqual({ epoch: "epoch-1", startSeq: 1, endSeq: 100 });
    expect(result.older).toBe("none");
  });

  it.each(["tail", "head"] as const)(
    "reconciles a pending submission from the %s included in a prompt-jump window",
    (lane) => {
      const clientMessageId = "pending-submission";
      const pending = makeSubmittedUserMessage("local pending prompt", clientMessageId);
      const result = processTimelineResponse({
        ...baseTimelineInput,
        currentTail: [
          {
            kind: "user_message",
            id: "newest",
            text: "newest",
            timestamp: new Date(100_000),
            timelineCursor: { epoch: "epoch-1", seq: 100 },
          },
          ...(lane === "tail" ? [pending] : []),
        ],
        currentHead: lane === "head" ? [pending] : [],
        currentCursor: { epoch: "epoch-1", startSeq: 80, endSeq: 100 },
        sendingClientMessageIds: [clientMessageId],
        payload: {
          ...baseTimelineInput.payload,
          direction: "before",
          mergeWindow: true,
          epoch: "epoch-1",
          startCursor: { seq: 1 },
          endCursor: { seq: 40 },
          hasOlder: false,
          hasNewer: true,
          entries: [
            {
              ...makeTimelineEntry(1, "canonical pending prompt", "user_message"),
              item: {
                type: "user_message",
                text: "canonical pending prompt",
                messageId: "canonical-message",
                clientMessageId,
              },
            },
          ],
        },
      });

      expect({
        userMessages: result.tail
          .filter((item) => item.kind === "user_message")
          .map(({ text, messageId, timelineCursor }) => ({ text, messageId, timelineCursor })),
        head: result.head,
        acknowledgedClientMessageIds: result.acknowledgedClientMessageIds,
      }).toEqual({
        userMessages: [
          {
            text: "local pending prompt",
            messageId: "canonical-message",
            timelineCursor: { epoch: "epoch-1", seq: 1 },
          },
          { text: "newest", messageId: undefined, timelineCursor: { epoch: "epoch-1", seq: 100 } },
        ],
        head: [],
        acknowledgedClientMessageIds: [clientMessageId],
      });
    },
  );

  it("does not duplicate a projected tool row that spans a prompt-jump window", () => {
    const currentTail = hydrateStreamState(
      [
        {
          event: makeToolCallTimelineEvent("call-1"),
          timestamp: new Date(500),
          timelineCursor: { epoch: "epoch-1", seq: 500 },
        },
      ],
      { source: "canonical" },
    );
    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail,
      currentCursor: { epoch: "epoch-1", startSeq: 400, endSeq: 500 },
      payload: {
        ...baseTimelineInput.payload,
        direction: "before",
        projection: "projected",
        mergeWindow: true,
        epoch: "epoch-1",
        startCursor: { seq: 1 },
        endCursor: { seq: 40 },
        hasOlder: false,
        hasNewer: true,
        entries: [
          {
            ...makeToolCallTimelineEntry(1, "call-1", "completed", {
              type: "read",
              filePath: "/tmp/example.ts",
            }),
            seqEnd: 500,
            sourceSeqRanges: [
              { startSeq: 1, endSeq: 1 },
              { startSeq: 500, endSeq: 500 },
            ],
            collapsed: ["tool_lifecycle"],
          },
        ],
      },
    });

    expect(
      getAgentToolCalls(result.tail).map((item) => ({
        callId: item.payload.data.callId,
        status: item.payload.data.status,
        timelineCursor: item.timelineCursor,
      })),
    ).toEqual([
      {
        callId: "call-1",
        status: "completed",
        timelineCursor: { epoch: "epoch-1", seq: 500 },
      },
    ]);
  });

  it("does not duplicate a projected assistant row that spans a prompt-jump window", () => {
    const timestamp = new Date(500);
    const currentTail: StreamItem[] = [
      {
        ...makeAssistantItem("projected response", "loaded-assistant"),
        messageId: "assistant-message",
        timestamp,
        timelineCursor: { epoch: "epoch-1", seq: 500 },
      },
    ];
    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail,
      currentCursor: { epoch: "epoch-1", startSeq: 400, endSeq: 500 },
      payload: {
        ...baseTimelineInput.payload,
        direction: "before",
        projection: "projected",
        mergeWindow: true,
        epoch: "epoch-1",
        startCursor: { seq: 1 },
        endCursor: { seq: 40 },
        hasOlder: false,
        hasNewer: true,
        entries: [
          {
            ...makeTimelineEntry(1, "projected response"),
            item: {
              type: "assistant_message",
              text: "projected response",
              messageId: "assistant-message",
            },
            timestamp: timestamp.toISOString(),
            seqEnd: 500,
            sourceSeqRanges: [
              { startSeq: 1, endSeq: 1 },
              { startSeq: 500, endSeq: 500 },
            ],
          },
        ],
      },
    });

    expect(
      result.tail
        .filter((item) => item.kind === "assistant_message")
        .map(({ id, text, messageId, timelineCursor }) => ({
          id,
          text,
          messageId,
          timelineCursor,
        })),
    ).toEqual([
      {
        id: "loaded-assistant",
        text: "projected response",
        messageId: "assistant-message",
        timelineCursor: { epoch: "epoch-1", seq: 500 },
      },
    ]);
  });

  it("drops a stale before page anchored before a resume-tail replacement", () => {
    const currentTail: StreamItem[] = [
      {
        kind: "user_message",
        id: "current-200",
        text: "current-200",
        timestamp: new Date(3200),
        timelineCursor: { epoch: "epoch-1", seq: 200 },
      },
    ];
    const existingCursor: TimelineCursor = {
      epoch: "epoch-1",
      startSeq: 200,
      endSeq: 240,
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
        endCursor: { seq: 39 },
        entries: [makeTimelineEntry(39, "stale older page", "user_message")],
      },
    });

    expect(result.tail).toBe(currentTail);
    expect(result.cursor).toBe(existingCursor);
    expect(result.cursorChanged).toBe(false);
    expect(result.older).toBe("unchanged");
  });

  it("does not reconcile an active submitted user message from a before-page response", () => {
    const submitted = makeSubmittedUserMessage("active prompt", "submitted-active");
    const existingCursor: TimelineCursor = {
      epoch: "epoch-1",
      startSeq: 3,
      endSeq: 5,
    };

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail: [submitted],
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
    expect(userMessages.map((item) => item.id)).toEqual(["canonical-before", "submitted-active"]);
    expect(userMessages[1]?.clientMessageId).toBe("submitted-active");
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
    const currentTail = [
      {
        ...makeAssistantItem("newer chunk", "assistant-newer"),
        timelineCursor: { epoch: "epoch-1", seq: 3 },
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
        startCursor: { seq: 1 },
        endCursor: { seq: 2 },
        entries: [makeTimelineEntry(1, "older chunk ")],
      },
    });

    expect(getAssistantTexts(result.tail)).toEqual(["older chunk newer chunk"]);
    expect(result.tail[0]).toEqual(
      expect.objectContaining({
        id: "assistant-newer",
        timelineCursor: { epoch: "epoch-1", seq: 3 },
      }),
    );
    expect(result.cursor).toEqual({
      epoch: "epoch-1",
      startSeq: 1,
      endSeq: 5,
    });
  });

  it("coalesces tool call lifecycle rows across the older-page prepend boundary", () => {
    const callId = "toolu_boundary";
    const turnId = "turn-boundary";
    const currentTail = hydrateStreamState(
      [
        {
          event: {
            type: "timeline",
            provider: "claude",
            turnId,
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
          makeToolCallTimelineEntry(
            1,
            callId,
            "running",
            {
              type: "unknown",
              input: { file_path: "/tmp/example.ts" },
              output: null,
            },
            turnId,
          ),
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
        id: `agent_tool_turn:${turnId}/${callId}`,
        callId,
        status: "completed",
        detailType: "read",
      },
    ]);
  });

  it("keeps the newest plugin row across the older-page prepend boundary", () => {
    const currentTail = hydrateStreamState(
      [
        {
          event: {
            type: "timeline",
            provider: "claude",
            item: makePluginTimelineEntry(3, "complete").item,
          },
          timestamp: new Date(3000),
        },
      ],
      { source: "canonical" },
    );

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail,
      currentCursor: { epoch: "epoch-1", startSeq: 3, endSeq: 5 },
      payload: {
        ...baseTimelineInput.payload,
        direction: "before",
        epoch: "epoch-1",
        startCursor: { seq: 1 },
        endCursor: { seq: 2 },
        entries: [makePluginTimelineEntry(1, "running")],
      },
    });

    expect(result.tail).toHaveLength(1);
    expect(result.tail[0]).toMatchObject({
      kind: "plugin",
      id: "review/review-1",
      data: { status: "complete" },
    });
  });

  it("removes a reconciled submitted prompt before coalescing a tool call at the pagination seam", () => {
    const clientMessageId = "client-boundary-prompt";
    const callId = "toolu_submitted_boundary";
    const currentTail = [
      makeSubmittedUserMessage("Inspect the file", clientMessageId),
      ...hydrateStreamState(
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
      ),
    ];

    const result = processTimelineResponse({
      ...baseTimelineInput,
      currentTail,
      currentCursor: { epoch: "epoch-1", startSeq: 3, endSeq: 5 },
      payload: {
        ...baseTimelineInput.payload,
        direction: "before",
        epoch: "epoch-1",
        startCursor: { seq: 1 },
        endCursor: { seq: 2 },
        entries: [
          {
            ...makeTimelineEntry(1, "Inspect the file", "user_message"),
            item: {
              type: "user_message",
              text: "Inspect the file",
              messageId: "provider-boundary-prompt",
              clientMessageId,
            },
          },
          makeToolCallTimelineEntry(2, callId, "running", {
            type: "unknown",
            input: { file_path: "/tmp/example.ts" },
            output: null,
          }),
        ],
      },
    });

    expect(result.tail.filter((item) => item.kind === "user_message")).toHaveLength(1);
    expect(getAgentToolCalls(result.tail)).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          data: expect.objectContaining({ callId, status: "completed" }),
        }),
      }),
    ]);
  });

  it("does not coalesce tool call lifecycle rows away from the prepend boundary", () => {
    const callId = "toolu_not_boundary";
    const olderTurnId = "autonomous-turn-1";
    const currentTurnId = "autonomous-turn-2";
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
            turnId: currentTurnId,
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
          makeToolCallTimelineEntry(
            1,
            callId,
            "running",
            {
              type: "unknown",
              input: { file_path: "/tmp/example.ts" },
              output: null,
            },
            olderTurnId,
          ),
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
        id: `agent_tool_turn:${olderTurnId}/${callId}`,
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
        id: `agent_tool_turn:${currentTurnId}/${callId}`,
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
  it("preserves the live timeline cursor on an assistant error", () => {
    const result = processAgentStreamEvent({
      ...baseStreamInput,
      event: makeAssistantTimelineEvent("[System Error] failed"),
      epoch: "timeline-1",
      seq: 42,
    });

    expect(result.head).toEqual([
      expect.objectContaining({
        kind: "assistant_message",
        text: "[System Error] failed",
        timelineCursor: { epoch: "timeline-1", seq: 42 },
      }),
    ]);
  });

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

  it("publishes task snapshots only from accepted timeline events", () => {
    const tasks = [
      { id: "inspect", text: "Inspect", status: "in_progress" as const, completed: false },
    ];
    const event: AgentStreamEventPayload = {
      type: "timeline",
      provider: "codex",
      item: {
        type: "todo",
        items: tasks,
      },
    };
    const currentCursor: TimelineCursor = {
      epoch: "epoch-1",
      startSeq: 1,
      endSeq: 4,
    };

    const accepted = processAgentStreamEvent({
      ...baseStreamInput,
      event,
      seq: 5,
      epoch: "epoch-1",
      currentCursor,
    });
    const stale = processAgentStreamEvent({
      ...baseStreamInput,
      event,
      seq: 4,
      epoch: "epoch-1",
      currentCursor,
    });
    const wrongEpoch = processAgentStreamEvent({
      ...baseStreamInput,
      event,
      seq: 5,
      epoch: "epoch-2",
      currentCursor,
    });
    const gapped = processAgentStreamEvent({
      ...baseStreamInput,
      event,
      seq: 8,
      epoch: "epoch-1",
      currentCursor,
    });

    expect(accepted.taskSnapshot).toEqual(tasks);
    expect(stale.taskSnapshot).toBeUndefined();
    expect(wrongEpoch.taskSnapshot).toBeUndefined();
    expect(gapped.taskSnapshot).toBeUndefined();
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

  it("renders a live row over painted items without creating an authoritative cursor", () => {
    const result = processAgentStreamEvent({
      ...baseStreamInput,
      event: makeTimelineEvent("live before bootstrap", "user_message"),
      seq: 51,
      epoch: "epoch-1",
      currentTail: [makeAssistantItem("painted replica")],
      currentCursor: undefined,
      hasAuthoritativeBaseline: false,
    });

    expect(getAssistantTexts(result.tail)).toEqual(["painted replica"]);
    expect(getUserTexts(result.head)).toEqual(["live before bootstrap"]);
    expect(result.head[0]).toMatchObject({
      kind: "user_message",
      timelineCursor: { epoch: "epoch-1", seq: 51 },
    });
    expect(result.cursorChanged).toBe(false);
    expect(result.cursor).toBeNull();
    expect(result.sideEffects).toEqual([]);
  });

  it("reconciles a pre-bootstrap echo with its submitted row", () => {
    const submitted = makeSubmittedUserMessage("submitted before bootstrap", "client-message-1");
    const result = processAgentStreamEvent({
      ...baseStreamInput,
      event: {
        type: "timeline",
        provider: "claude",
        item: {
          type: "user_message",
          text: "canonical presentation",
          clientMessageId: "client-message-1",
          messageId: "provider-message-1",
        },
      },
      seq: 51,
      epoch: "epoch-1",
      currentTail: [makeAssistantItem("painted replica"), submitted],
      currentCursor: undefined,
      hasAuthoritativeBaseline: false,
    });

    const users = [...result.tail, ...result.head].filter((item) => item.kind === "user_message");
    expect(users).toEqual([
      expect.objectContaining({
        id: "client-message-1",
        clientMessageId: "client-message-1",
        messageId: "provider-message-1",
        text: "submitted before bootstrap",
        timelineCursor: { epoch: "epoch-1", seq: 51 },
      }),
    ]);
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
    });

    expect(result.changedTail).toBe(true);
    expect(result.changedHead).toBe(true);
    expect(getAssistantTexts(result.tail)).toEqual(["Anonymous"]);
    expect(getAssistantTexts(result.head)).toEqual(["Identified"]);
  });

  it("keeps a promoted live image block identity when the turn completes", () => {
    const imageMarkdown = "![Architecture](docs/architecture.png)";
    const streaming = processAgentStreamEvents({
      events: [
        makeStreamReducerEvent(makeTimelineEvent("Introductory paragraph"), 1),
        makeStreamReducerEvent(makeTimelineEvent(`\n\n${imageMarkdown}`), 2),
      ],
      currentTail: [],
      currentHead: [],
      currentCursor: undefined,
    });

    expect([streaming.changedTail, streaming.changedHead]).toEqual([true, true]);
    expect(getAssistantTexts(streaming.tail)).toEqual(["Introductory paragraph"]);
    expect(getAssistantTexts(streaming.head)).toEqual([imageMarkdown]);
    const liveImageId = streaming.head[0]?.id;

    const completed = processAgentStreamEvent({
      ...baseStreamInput,
      event: { type: "turn_completed", provider: "claude" } as AgentStreamEventPayload,
      currentTail: streaming.tail,
      currentHead: streaming.head,
      currentCursor: streaming.cursor ?? undefined,
    });
    const assistantBlocks = [...completed.tail, ...completed.head].filter(
      (item): item is Extract<StreamItem, { kind: "assistant_message" }> =>
        item.kind === "assistant_message",
    );
    expect(assistantBlocks.map((item) => [item.id, item.text])).toEqual([
      [streaming.tail[0]?.id, "Introductory paragraph"],
      [liveImageId, imageMarkdown],
    ]);
    expect(assistantBlocks.filter((item) => item.id === liveImageId)).toHaveLength(1);
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
    });

    expect(getAssistantTexts([...result.tail, ...result.head])).toEqual([
      "ABC",
      imageMarkdown,
      "D",
      "E",
    ]);
  });

  it("does not derive lifecycle state from a terminal event in a batch", () => {
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
    });

    expect(result.head).toEqual([]);
    expect(result.tail).toHaveLength(1);
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
        projection: "projected",
        reset: false,
        epoch: "epoch-1",
        window: { minSeq: 186, maxSeq: 186, nextSeq: 187 },
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
        projection: "projected",
        reset: false,
        epoch: "epoch-1",
        window: { minSeq: 10, maxSeq: 10, nextSeq: 11 },
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
