import { describe, expect, it } from "vitest";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import type { TimelineItemTransform } from "./model";
import {
  processAgentStreamEvent,
  processTimelineResponse,
} from "@/timeline/session-stream-reducers";

const transform: TimelineItemTransform = (item) => {
  if (item.type !== "tool_call" || item.status === "running") return;
  return [
    {
      type: "plugin",
      pluginId: "reports",
      kind: "test-report",
      version: 1,
      data: { name: item.name },
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
  it("applies the same transform to fetched projected history", () => {
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
      },
    ]);
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
