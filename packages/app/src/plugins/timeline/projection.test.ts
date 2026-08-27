import { describe, expect, it } from "vitest";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import type { StreamItem } from "@/types/stream";
import {
  processAgentStreamEvent,
  processTimelineResponse,
  type ProcessTimelineResponseInput,
} from "@/timeline/session-stream-reducers";
import type { TimelineItemTransform } from "./model";

type TimelinePayload = ProcessTimelineResponseInput["payload"];
type TimelineEntry = TimelinePayload["entries"][number];
type TimelineEvent = Extract<AgentStreamEventPayload, { type: "timeline" }>;

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

const event: TimelineEvent = {
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

function makeSource(
  seqStart = 2,
  seqEnd = seqStart,
  sourceSeqRanges = [{ startSeq: seqStart, endSeq: seqEnd }],
) {
  return { epoch: "epoch-1", seqStart, seqEnd, sourceSeqRanges };
}

function makePluginItem(id = "live-plugin", source = makeSource()): StreamItem {
  return {
    kind: "plugin",
    id,
    pluginId: "reports",
    itemKind: "test-report",
    version: 1,
    data: { name: "tests" },
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
    timelineCursor: { epoch: "epoch-1", seq: source.seqEnd },
    source,
  };
}

function makeEntry(
  seqStart: number,
  seqEnd = seqStart,
  options: {
    sourceSeqRanges?: TimelineEntry["sourceSeqRanges"];
    item?: TimelineEntry["item"];
  } = {},
): TimelineEntry {
  return {
    seqStart,
    seqEnd,
    provider: "claude",
    item: options.item ?? event.item,
    timestamp: "2026-01-01T00:00:01.000Z",
    ...(options.sourceSeqRanges ? { sourceSeqRanges: options.sourceSeqRanges } : {}),
  };
}

const basePayload: TimelinePayload = {
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
};

function processProjection(
  payload: Partial<TimelinePayload>,
  options: {
    currentTail?: StreamItem[];
    currentHead?: StreamItem[];
    currentCursor?: ProcessTimelineResponseInput["currentCursor"];
    isInitializing?: boolean;
    hasActiveInitDeferred?: boolean;
    initRequestDirection?: ProcessTimelineResponseInput["initRequestDirection"];
    transformTimelineItem?: TimelineItemTransform;
  } = {},
) {
  return processTimelineResponse({
    payload: { ...basePayload, ...payload },
    currentTail: options.currentTail ?? [],
    currentHead: options.currentHead ?? [],
    currentCursor: options.currentCursor,
    isInitializing: options.isInitializing ?? false,
    hasActiveInitDeferred: options.hasActiveInitDeferred ?? false,
    initRequestDirection: options.initRequestDirection ?? "tail",
    sendingClientMessageIds: [],
    transformTimelineItem: options.transformTimelineItem,
  });
}

function livePluginOptions() {
  return {
    currentTail: [makePluginItem()],
    currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 2 },
    initRequestDirection: "after" as const,
    transformTimelineItem: transform,
  };
}

const pluginReconciliationCases: Array<{
  name: string;
  payload: Partial<TimelinePayload>;
  currentCursor: { epoch: string; startSeq: number; endSeq: number };
  sourceSeqEnd: number;
}> = [
  {
    name: "overlapping forward history",
    payload: {
      window: { minSeq: 1, maxSeq: 3, nextSeq: 4 },
      startCursor: { seq: 3 },
      endCursor: { seq: 3 },
      entries: [makeEntry(1, 3, { sourceSeqRanges: [{ startSeq: 1, endSeq: 3 }] })],
    },
    currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 2 },
    sourceSeqEnd: 3,
  },
  {
    name: "inclusive merge-window boundary",
    payload: {
      direction: "before",
      window: { minSeq: 1, maxSeq: 2, nextSeq: 3 },
      startCursor: { seq: 1 },
      endCursor: { seq: 1 },
      mergeWindow: true,
      hasNewer: true,
      entries: [
        makeEntry(1, 2, {
          sourceSeqRanges: [
            { startSeq: 1, endSeq: 1 },
            { startSeq: 2, endSeq: 2 },
          ],
        }),
      ],
    },
    currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 2 },
    sourceSeqEnd: 2,
  },
  {
    name: "older-page boundary",
    payload: {
      direction: "before",
      window: { minSeq: 1, maxSeq: 2, nextSeq: 3 },
      startCursor: { seq: 1 },
      endCursor: { seq: 1 },
      entries: [makeEntry(1, 2, { sourceSeqRanges: [{ startSeq: 1, endSeq: 2 }] })],
    },
    currentCursor: { epoch: "epoch-1", startSeq: 2, endSeq: 2 },
    sourceSeqEnd: 2,
  },
];

describe("plugin timeline projection", () => {
  it("uses null source when projected history lacks authoritative ranges", () => {
    const result = processProjection(
      {
        direction: "tail",
        reset: true,
        window: { minSeq: 1, maxSeq: 1, nextSeq: 2 },
        startCursor: { seq: 1 },
        endCursor: { seq: 1 },
        entries: [makeEntry(1)],
      },
      {
        isInitializing: true,
        hasActiveInitDeferred: true,
        transformTimelineItem: transform,
      },
    );

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
    const authoritativeSource = makeSource(4, 9, [
      { startSeq: 4, endSeq: 5 },
      { startSeq: 9, endSeq: 9 },
    ]);
    const result = processProjection(
      {
        direction: "tail",
        reset: true,
        window: { minSeq: 4, maxSeq: 9, nextSeq: 10 },
        startCursor: { seq: 4 },
        endCursor: { seq: 9 },
        entries: [makeEntry(4, 9, { sourceSeqRanges: authoritativeSource.sourceSeqRanges })],
      },
      {
        isInitializing: true,
        hasActiveInitDeferred: true,
        transformTimelineItem: multipleItems,
      },
    );

    const pluginItems = result.tail.filter((item) => item.kind === "plugin");
    expect(pluginItems).toHaveLength(2);
    expect(pluginItems.map((item) => item.source)).toEqual([
      authoritativeSource,
      authoritativeSource,
    ]);
    expect(pluginItems[0]?.source).toBe(pluginItems[1]?.source);
    expect(Object.isFrozen(pluginItems[0]?.source)).toBe(true);
    expect(Object.isFrozen(pluginItems[0]?.source?.sourceSeqRanges)).toBe(true);
    expect(Object.isFrozen(pluginItems[0]?.source?.sourceSeqRanges[0])).toBe(true);
  });

  it.each(pluginReconciliationCases)(
    "reconciles $name",
    ({ payload, currentCursor, sourceSeqEnd }) => {
      const result = processProjection(payload, {
        ...livePluginOptions(),
        currentCursor,
      });
      expect(result.tail.filter((item) => item.kind === "plugin")).toHaveLength(1);
      expect(result.tail[0]).toMatchObject({
        id: "live-plugin",
        source: { seqStart: 1, seqEnd: sourceSeqEnd },
      });
    },
  );

  it("continues merging an assistant boundary after plugin reconciliation", () => {
    const result = processProjection(
      {
        direction: "before",
        window: { minSeq: 1, maxSeq: 6, nextSeq: 7 },
        startCursor: { seq: 1 },
        endCursor: { seq: 1 },
        entries: [
          makeEntry(1, 5, { sourceSeqRanges: [{ startSeq: 1, endSeq: 5 }] }),
          makeEntry(1, 1, { item: { type: "assistant_message", text: "Older" } }),
        ],
      },
      {
        currentTail: [
          makePluginItem("live-plugin", makeSource(5)),
          {
            kind: "assistant_message",
            id: "live-assistant",
            text: "New",
            timestamp: new Date("2026-01-01T00:00:00.000Z"),
            timelineCursor: { epoch: "epoch-1", seq: 6 },
          },
        ],
        currentCursor: { epoch: "epoch-1", startSeq: 2, endSeq: 6 },
        initRequestDirection: "after",
        transformTimelineItem: transform,
      },
    );

    expect(result.tail).toMatchObject([
      { kind: "plugin", id: "live-plugin" },
      { kind: "assistant_message", id: "live-assistant", text: "OlderNew" },
    ]);
  });

  it("passes a single-source context to live transform checks", () => {
    let received: Parameters<TimelineItemTransform> | undefined;
    const liveTransform: TimelineItemTransform = (...args) => {
      received = args;
      return undefined;
    };

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

    expect(received).toEqual([
      event.item,
      {
        epoch: "epoch-1",
        seqStart: 7,
        seqEnd: 7,
        sourceSeqRanges: [{ startSeq: 7, endSeq: 7 }],
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
