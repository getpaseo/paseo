import { describe, expect, it, vi } from "vitest";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import type { TimelineItemTransform } from "./model";
import {
  processAgentStreamEvent,
  processTimelineResponse,
} from "@/timeline/session-stream-reducers";

const transform: TimelineItemTransform = (item, source) => {
  if (item.type !== "tool_call" || item.status === "running") return;
  return [
    {
      type: "plugin",
      pluginId: "reports",
      kind: "test-report",
      version: 1,
      data: { name: item.name },
      source,
    },
  ];
};

const event: AgentStreamEventPayload = {
  type: "timeline",
  provider: "claude",
  item: {
    type: "tool_call",
    callId: "call-1",
    name: "tests",
    detail: { type: "unknown", input: null, output: null },
    status: "completed",
    error: null,
  },
};

describe("plugin timeline projection", () => {
  it("uses null source when projected history lacks authoritative ranges", () => {
    const result = processTimelineResponse({
      payload: {
        agentId: "agent-1",
        direction: "tail",
        projection: "projected",
        reset: true,
        epoch: "epoch-1",
        window: { minSeq: 1, maxSeq: 1, nextSeq: 2 },
        startCursor: { seq: 1 },
        endCursor: { seq: 1 },
        entries: [
          {
            seqStart: 1,
            seqEnd: 1,
            provider: "claude",
            item: event.item,
            timestamp: "2026-01-01T00:00:00.000Z",
          },
        ],
        error: null,
        hasNewer: false,
        hasOlder: false,
      },
      currentTail: [],
      currentHead: [],
      currentCursor: undefined,
      isInitializing: true,
      hasActiveInitDeferred: true,
      initRequestDirection: "tail",
      sendingClientMessageIds: [],
      transformTimelineItem: transform,
    });

    expect(result.tail).toMatchObject([
      {
        kind: "plugin",
        pluginId: "reports",
        itemKind: "test-report",
        data: { name: "tests" },
        timelineCursor: { epoch: "epoch-1", seq: 1 },
        source: null,
      },
    ]);
  });

  it("preserves every authoritative range on each replacement item", () => {
    const multipleItems: TimelineItemTransform = (item, source) => {
      if (item.type !== "tool_call") return;
      return [
        {
          type: "plugin",
          pluginId: "reports",
          kind: "test-report",
          version: 1,
          data: { position: "first" },
          source,
        },
        {
          type: "plugin",
          pluginId: "reports",
          kind: "test-report",
          version: 1,
          data: { position: "second" },
          source,
        },
      ];
    };
    const result = processTimelineResponse({
      payload: {
        agentId: "agent-1",
        direction: "tail",
        projection: "projected",
        reset: true,
        epoch: "epoch-1",
        window: { minSeq: 4, maxSeq: 9, nextSeq: 10 },
        startCursor: { seq: 4 },
        endCursor: { seq: 9 },
        entries: [
          {
            seqStart: 4,
            seqEnd: 9,
            sourceSeqRanges: [
              { startSeq: 4, endSeq: 5 },
              { startSeq: 9, endSeq: 9 },
            ],
            provider: "claude",
            item: event.item,
            timestamp: "2026-01-01T00:00:00.000Z",
          },
        ],
        error: null,
        hasNewer: false,
        hasOlder: false,
      },
      currentTail: [],
      currentHead: [],
      currentCursor: undefined,
      isInitializing: true,
      hasActiveInitDeferred: true,
      initRequestDirection: "tail",
      sendingClientMessageIds: [],
      transformTimelineItem: multipleItems,
    });

    const pluginItems = result.tail.filter((item) => item.kind === "plugin");
    expect(pluginItems).toHaveLength(2);
    expect(pluginItems.map((item) => item.source)).toEqual([
      {
        epoch: "epoch-1",
        seqStart: 4,
        seqEnd: 9,
        sourceSeqRanges: [
          { startSeq: 4, endSeq: 5 },
          { startSeq: 9, endSeq: 9 },
        ],
      },
      {
        epoch: "epoch-1",
        seqStart: 4,
        seqEnd: 9,
        sourceSeqRanges: [
          { startSeq: 4, endSeq: 5 },
          { startSeq: 9, endSeq: 9 },
        ],
      },
    ]);
    expect(pluginItems[0]?.source).toBe(pluginItems[1]?.source);
    expect(Object.isFrozen(pluginItems[0]?.source)).toBe(true);
    expect(Object.isFrozen(pluginItems[0]?.source?.sourceSeqRanges)).toBe(true);
    expect(Object.isFrozen(pluginItems[0]?.source?.sourceSeqRanges[0])).toBe(true);
  });

  it("passes a single-source context to live transform checks", () => {
    const liveTransform = vi.fn<TimelineItemTransform>(() => undefined);

    processAgentStreamEvent({
      event,
      seq: 7,
      epoch: "epoch-1",
      currentTail: [],
      currentHead: [],
      currentCursor: undefined,
      timestamp: new Date("2026-01-01T00:00:00.000Z"),
      transformTimelineItem: liveTransform,
    });

    expect(liveTransform).toHaveBeenCalledWith(event.item, {
      epoch: "epoch-1",
      seqStart: 7,
      seqEnd: 7,
      sourceSeqRanges: [{ startSeq: 7, endSeq: 7 }],
    });
  });

  it("requests authoritative projection when a live delta matches", () => {
    const result = processAgentStreamEvent({
      event,
      seq: 1,
      epoch: "epoch-1",
      currentTail: [],
      currentHead: [],
      currentCursor: undefined,
      timestamp: new Date("2026-01-01T00:00:00.000Z"),
      transformTimelineItem: transform,
    });

    expect(result.tail).toMatchObject([
      {
        kind: "tool_call",
        timelineCursor: { epoch: "epoch-1", seq: 1 },
      },
    ]);
    expect(result.sideEffects).toContainEqual({ type: "reproject" });
  });
});
