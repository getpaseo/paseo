import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import {
  collectAssistantResponseContentForStreamRenderStrategy,
  getBottomOffsetForStreamRenderStrategy,
  getFrameChildOrderForStreamRenderStrategy,
  getHistoryLiveBoundaryIndexForStreamRenderStrategy,
  getLiveHeadHistoryBoundaryIndexForStreamRenderStrategy,
  getStreamEdgeSlotProps,
  getStreamNeighborIndex,
  getStreamNeighborItem,
  isNearBottomForStreamRenderStrategy,
  orderHeadForStreamRenderStrategy,
  orderTailForStreamRenderStrategy,
} from "./strategy";
import { resolveStreamRenderStrategy } from "./strategy-resolver";

function createTimestamp(seed: number): Date {
  return new Date(`2026-01-01T00:00:0${seed}.000Z`);
}

function userMessage(id: string, text: string, seed: number): StreamItem {
  return {
    kind: "user_message",
    id,
    text,
    timestamp: createTimestamp(seed),
  };
}

function assistantMessage(id: string, text: string, seed: number): StreamItem {
  return {
    kind: "assistant_message",
    id,
    text,
    timestamp: createTimestamp(seed),
  };
}

function toolCall(id: string, seed: number): StreamItem {
  return {
    kind: "tool_call",
    id,
    timestamp: createTimestamp(seed),
    payload: {
      source: "orchestrator",
      data: {
        toolCallId: id,
        toolName: "Shell",
        arguments: "echo hi",
        result: null,
        status: "completed",
      },
    },
  };
}

describe("resolveStreamRenderStrategy", () => {
  it("uses forward_stream on web", () => {
    const strategy = resolveStreamRenderStrategy({
      platform: "web",
      isMobileBreakpoint: false,
    });

    expect(strategy.shouldUseVirtualizedList()).toBe(false);
    expect(strategy.shouldAnchorBottomOnContentSizeChange()).toBe(true);
    expect(strategy.getBottomAnchorTransportBehavior()).toEqual({
      verificationDelayFrames: 0,
      verificationRetryMode: "rescroll",
    });
  });

  it("uses a virtualized forward stream on native", () => {
    const strategy = resolveStreamRenderStrategy({
      platform: "ios",
      isMobileBreakpoint: false,
    });

    expect(strategy.shouldUseVirtualizedList()).toBe(true);
    expect(strategy.shouldAnchorBottomOnContentSizeChange()).toBe(false);
    expect(strategy.getBottomAnchorTransportBehavior()).toEqual({
      verificationDelayFrames: 2,
      verificationRetryMode: "recheck",
    });
  });
});

const PLATFORMS = ["web", "ios", "android"] as const;

function strategyFor(platform: (typeof PLATFORMS)[number]) {
  return resolveStreamRenderStrategy({ platform, isMobileBreakpoint: false });
}

describe("stream ordering", () => {
  const streamItems: StreamItem[] = [
    userMessage("u1", "user-1", 1),
    assistantMessage("a1", "assistant-1", 2),
    assistantMessage("a2", "assistant-2", 3),
  ];

  it.each(PLATFORMS)("keeps oldest-to-newest order for tail and head on %s", (platform) => {
    const strategy = strategyFor(platform);

    const tail = orderTailForStreamRenderStrategy({ strategy, streamItems });
    const head = orderHeadForStreamRenderStrategy({ strategy, streamHead: streamItems });

    expect(tail.map((item) => item.id)).toEqual(["u1", "a1", "a2"]);
    expect(head.map((item) => item.id)).toEqual(["u1", "a1", "a2"]);
  });
});

describe("neighbor and traversal semantics", () => {
  it.each(PLATFORMS)("maps above/below indices on %s", (platform) => {
    const strategy = strategyFor(platform);

    expect(getStreamNeighborIndex({ strategy, index: 3, relation: "above" })).toBe(2);
    expect(getStreamNeighborIndex({ strategy, index: 3, relation: "below" })).toBe(4);
  });

  it.each(PLATFORMS)("collects assistant response content on %s", (platform) => {
    const chronological: StreamItem[] = [
      userMessage("u1", "user-1", 1),
      assistantMessage("a1", "assistant-1", 2),
      assistantMessage("a2", "assistant-2", 3),
      userMessage("u2", "user-2", 4),
    ];
    const strategy = strategyFor(platform);
    const items = orderTailForStreamRenderStrategy({ strategy, streamItems: chronological });

    expect(
      collectAssistantResponseContentForStreamRenderStrategy({
        strategy,
        items,
        startIndex: items.findIndex((item) => item.id === "a2"),
      }),
    ).toBe("assistant-1\n\nassistant-2");
  });

  it("keeps copied content within the canonical turn without a visible prompt", () => {
    const chronological: StreamItem[] = [
      { ...assistantMessage("a1", "first turn", 1), turnId: "turn-1" },
      { ...toolCall("tool", 2), turnId: "turn-2" },
      { ...assistantMessage("a2", "second turn", 3), turnId: "turn-2" },
    ];
    const strategy = strategyFor("web");

    expect(
      collectAssistantResponseContentForStreamRenderStrategy({
        strategy,
        items: chronological,
        startIndex: 2,
      }),
    ).toBe("second turn");
  });

  it("returns undefined neighbor when index would be out of bounds", () => {
    const strategy = strategyFor("web");
    const items: StreamItem[] = [userMessage("u1", "user-1", 1)];

    expect(getStreamNeighborItem({ strategy, items, index: 0, relation: "above" })).toBeUndefined();
    expect(getStreamNeighborItem({ strategy, items, index: 0, relation: "below" })).toBeUndefined();
  });
});

describe("scroll/bottom calculations", () => {
  it.each(PLATFORMS)("computes near-bottom from the distance to the end on %s", (platform) => {
    const strategy = strategyFor(platform);

    expect(
      isNearBottomForStreamRenderStrategy({
        strategy,
        offsetY: 680,
        viewportHeight: 300,
        contentHeight: 1000,
        threshold: 24,
      }),
    ).toBe(true);
    expect(
      isNearBottomForStreamRenderStrategy({
        strategy,
        offsetY: 600,
        viewportHeight: 300,
        contentHeight: 1000,
        threshold: 24,
      }),
    ).toBe(false);
  });

  it.each(PLATFORMS)("maps scroll-to-bottom to the max offset on %s", (platform) => {
    expect(
      getBottomOffsetForStreamRenderStrategy({
        strategy: strategyFor(platform),
        viewportHeight: 320,
        contentHeight: 1000,
      }),
    ).toBe(680);
  });
});

describe("edge slot semantics", () => {
  it.each(PLATFORMS)("uses the footer slot on %s", (platform) => {
    const EdgeSlot = () => null;

    expect(
      getStreamEdgeSlotProps({ strategy: strategyFor(platform), component: EdgeSlot, gapSize: 4 }),
    ).toEqual({
      ListFooterComponent: EdgeSlot,
      ListFooterComponentStyle: { marginTop: 4 },
    });
  });
});

describe("layout strategy edges", () => {
  const streamItems: StreamItem[] = [
    userMessage("u1", "user-1", 1),
    assistantMessage("a1", "assistant-1", 2),
  ];

  it.each(PLATFORMS)(
    "uses the newest history edge as the history/live boundary on %s",
    (platform) => {
      const strategy = strategyFor(platform);
      const history = orderTailForStreamRenderStrategy({ strategy, streamItems });

      expect(getHistoryLiveBoundaryIndexForStreamRenderStrategy({ strategy, history })).toBe(1);
    },
  );

  it.each(PLATFORMS)(
    "uses the oldest live-head edge as the live-head/history boundary on %s",
    (platform) => {
      const strategy = strategyFor(platform);
      const liveHead = orderHeadForStreamRenderStrategy({ strategy, streamHead: streamItems });

      expect(getLiveHeadHistoryBoundaryIndexForStreamRenderStrategy({ strategy, liveHead })).toBe(
        0,
      );
    },
  );

  it.each(PLATFORMS)("renders a cell's content before its footer on %s", (platform) => {
    expect(getFrameChildOrderForStreamRenderStrategy({ strategy: strategyFor(platform) })).toBe(
      "content-then-footer",
    );
  });
});
