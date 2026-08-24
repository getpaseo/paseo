import { describe, expect, it } from "vitest";
import type { TurnTiming } from "@/timeline/turn-time";
import type { StreamItem } from "@/types/stream";
import { layoutStream } from "./layout";
import type { StreamStrategy } from "./strategy";

function strategyFor(platform: "web" | "native"): StreamStrategy {
  const inverted = platform === "native";
  const neighborStep = inverted ? 1 : -1;
  const getHistoryBoundaryIndex = (items: StreamItem[]) => {
    if (items.length === 0) return null;
    return inverted ? 0 : items.length - 1;
  };
  const getLiveHeadBoundaryIndex = (items: StreamItem[]) => {
    if (items.length === 0) return null;
    return inverted ? items.length - 1 : 0;
  };
  return {
    orderTail: (items) => (inverted ? [...items].toReversed() : items),
    orderHead: (items) => (inverted ? [...items].toReversed() : items),
    getNeighborIndex: (index, relation) =>
      relation === "above" ? index + neighborStep : index - neighborStep,
    getNeighborItem: (items, index, relation) => {
      const neighborIndex = relation === "above" ? index + neighborStep : index - neighborStep;
      return items[neighborIndex];
    },
    getHistoryLiveBoundaryIndex: getHistoryBoundaryIndex,
    getLiveHeadHistoryBoundaryIndex: getLiveHeadBoundaryIndex,
    getLatestItemIndex: getHistoryBoundaryIndex,
    getFrameChildOrder: () => (inverted ? "footer-then-content" : "content-then-footer"),
  } as StreamStrategy;
}

function userMessage(id: string): Extract<StreamItem, { kind: "user_message" }> {
  return {
    kind: "user_message",
    id,
    text: id,
    timestamp: new Date("2026-08-22T10:00:00.000Z"),
  };
}

function assistantMessage(id: string): Extract<StreamItem, { kind: "assistant_message" }> {
  return {
    kind: "assistant_message",
    id,
    text: id,
    timestamp: new Date("2026-08-22T10:00:01.000Z"),
  };
}

function assistantBlock(
  id: string,
  blockIndex: number,
): Extract<StreamItem, { kind: "assistant_message" }> {
  return {
    ...assistantMessage(id),
    blockGroupId: "response",
    blockIndex,
  };
}

function timingFor(assistantId: string): Map<string, TurnTiming> {
  return new Map([
    [
      assistantId,
      {
        startedAt: new Date("2026-08-22T10:00:00.000Z"),
        completedAt: new Date("2026-08-22T10:00:02.000Z"),
        durationMs: 2_000,
      },
    ],
  ]);
}

function layoutFor(input: { platform: "web" | "native"; isTurnActive: boolean }) {
  const strategy = strategyFor(input.platform);
  const assistant = assistantMessage("assistant");
  return {
    assistant,
    layout: layoutStream({
      strategy,
      isTurnActive: input.isTurnActive,
      history: strategy.orderTail([userMessage("user"), assistant]),
      liveHead: [],
      timingByAssistantId: timingFor(assistant.id),
    }),
  };
}

describe("turn footer spacing", () => {
  it.each(["web", "native"] as const)(
    "compacts the last assistant against the completed footer on %s",
    (platform) => {
      const { assistant, layout } = layoutFor({ platform, isTurnActive: false });
      const assistantLayout = layout.history.find((item) => item.item.id === assistant.id);

      expect(layout.auxiliaryTurnFooter?.itemId).toBe(assistant.id);
      expect(assistantLayout?.assistantSpacing).toBe("compactBottom");
    },
  );

  it.each(["web", "native"] as const)(
    "keeps the same compact edge while the footer is running on %s",
    (platform) => {
      const { assistant, layout } = layoutFor({ platform, isTurnActive: true });
      const assistantLayout = layout.history.find((item) => item.item.id === assistant.id);

      expect(layout.auxiliaryTurnFooter).toBeNull();
      expect(assistantLayout?.assistantSpacing).toBe("compactBottom");
    },
  );

  it.each([
    ["web", false],
    ["web", true],
    ["native", false],
    ["native", true],
  ] as const)(
    "compacts both edges of the final split paragraph on %s when active=%s",
    (platform, isTurnActive) => {
      const strategy = strategyFor(platform);
      const first = assistantBlock("first", 0);
      const last = assistantBlock("last", 1);
      const layout = layoutStream({
        strategy,
        isTurnActive,
        history: strategy.orderTail([userMessage("user"), first]),
        liveHead: strategy.orderHead([last]),
        timingByAssistantId: timingFor(last.id),
      });
      const firstLayout = layout.history.find((item) => item.item.id === first.id);
      const lastLayout = layout.liveHead.find((item) => item.item.id === last.id);

      expect(firstLayout?.assistantSpacing).toBe("compactBottom");
      expect(lastLayout?.assistantSpacing).toBe("compactBoth");
    },
  );
});
