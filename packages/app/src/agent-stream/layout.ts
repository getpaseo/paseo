import type { TurnTiming } from "@/timeline/turn-time";
import type { StreamItem } from "@/types/stream";
import { getAssistantBlockSpacing, getGapBetweenStreamItems } from "./spacing";
import type { StreamFrameChildOrder, StreamStrategy } from "./strategy";

export type StreamToolSequence = "single" | "first" | "middle" | "last" | "none";

export interface TurnFooterHost {
  itemId: string;
  items: StreamItem[];
  timing?: TurnTiming;
  startIndex: number;
}

export interface StreamLayoutItem {
  item: StreamItem;
  index: number;
  items: StreamItem[];
  aboveItem: StreamItem | null;
  belowItem: StreamItem | null;
  gapBelow: number;
  assistantSpacing: "default" | "compactTop" | "compactBottom" | "compactBoth";
  completedFooter: TurnFooterHost | null;
  toolSequence: StreamToolSequence;
  isFirstInUserGroup: boolean;
  isLastInUserGroup: boolean;
  isLastInToolSequence: boolean;
  frameOrder: StreamFrameChildOrder;
}

export interface StreamLayout {
  history: StreamLayoutItem[];
  liveHead: StreamLayoutItem[];
  auxiliaryTurnFooter: TurnFooterHost | null;
}

export interface StreamLayoutInput {
  strategy: StreamStrategy;
  agentStatus: string;
  history: StreamItem[];
  liveHead: StreamItem[];
  timingByAssistantId: Map<string, TurnTiming>;
}

interface LayoutSegmentInput {
  strategy: StreamStrategy;
  agentStatus: string;
  items: StreamItem[];
  timingByAssistantId: Map<string, TurnTiming>;
  auxiliaryTurnFooter: TurnFooterHost | null;
  frameOrder: StreamFrameChildOrder;
  boundaryIndex: number | null;
  boundaryAboveItem: StreamItem | null;
  boundaryBelowItem: StreamItem | null;
}

function createTurnFooterHost(input: {
  item: StreamItem;
  items: StreamItem[];
  index: number;
  timingByAssistantId: Map<string, TurnTiming>;
}): TurnFooterHost {
  return {
    itemId: input.item.id,
    items: input.items,
    timing: input.timingByAssistantId.get(input.item.id),
    startIndex: input.index,
  };
}

function resolveAuxiliaryTurnFooter(input: StreamLayoutInput): TurnFooterHost | null {
  if (input.agentStatus === "running") {
    return null;
  }

  const footerItems = input.liveHead.length > 0 ? input.liveHead : input.history;
  const startIndex = input.strategy.getLatestItemIndex(footerItems);
  if (startIndex === null) {
    return null;
  }

  const item = footerItems[startIndex];
  if (!item || item.kind !== "assistant_message") {
    return null;
  }

  return createTurnFooterHost({
    item,
    items: footerItems,
    index: startIndex,
    timingByAssistantId: input.timingByAssistantId,
  });
}

function shouldRenderCompletedFooter(input: {
  item: StreamItem;
  belowItem: StreamItem | null;
  agentStatus: string;
  auxiliaryTurnFooter: TurnFooterHost | null;
}): boolean {
  return (
    input.item.kind === "assistant_message" &&
    input.auxiliaryTurnFooter?.itemId !== input.item.id &&
    (input.belowItem?.kind === "user_message" ||
      (input.belowItem === null && input.agentStatus !== "running"))
  );
}

function isToolSequenceItem(item: StreamItem | null): boolean {
  return item?.kind === "tool_call" || item?.kind === "thought" || item?.kind === "todo_list";
}

function getToolSequence(input: {
  item: StreamItem;
  aboveItem: StreamItem | null;
  belowItem: StreamItem | null;
}): StreamToolSequence {
  if (!isToolSequenceItem(input.item)) {
    return "none";
  }

  const hasAbove = isToolSequenceItem(input.aboveItem);
  const hasBelow = isToolSequenceItem(input.belowItem);
  if (hasAbove && hasBelow) {
    return "middle";
  }
  if (hasAbove) {
    return "last";
  }
  if (hasBelow) {
    return "first";
  }
  return "single";
}

function getSegmentNeighbor(input: {
  strategy: StreamStrategy;
  items: StreamItem[];
  index: number;
  relation: "above" | "below";
  boundaryIndex: number | null;
  boundaryItem: StreamItem | null;
}): StreamItem | null {
  const neighbor = input.strategy.getNeighborItem(input.items, input.index, input.relation);
  if (neighbor) {
    return neighbor;
  }
  if (input.index === input.boundaryIndex) {
    return input.boundaryItem;
  }
  return null;
}

function layoutSegment(input: LayoutSegmentInput): StreamLayoutItem[] {
  return input.items.map((item, index) => {
    const aboveItem = getSegmentNeighbor({
      strategy: input.strategy,
      items: input.items,
      index,
      relation: "above",
      boundaryIndex: input.boundaryIndex,
      boundaryItem: input.boundaryAboveItem,
    });
    const belowItem = getSegmentNeighbor({
      strategy: input.strategy,
      items: input.items,
      index,
      relation: "below",
      boundaryIndex: input.boundaryIndex,
      boundaryItem: input.boundaryBelowItem,
    });
    const assistantSpacing = getAssistantBlockSpacing({
      item,
      aboveItem,
      belowItem,
    });
    const completedFooter = shouldRenderCompletedFooter({
      item,
      belowItem,
      agentStatus: input.agentStatus,
      auxiliaryTurnFooter: input.auxiliaryTurnFooter,
    })
      ? createTurnFooterHost({
          item,
          items: input.items,
          index,
          timingByAssistantId: input.timingByAssistantId,
        })
      : null;

    return {
      item,
      index,
      items: input.items,
      aboveItem,
      belowItem,
      gapBelow: completedFooter ? 0 : getGapBetweenStreamItems(item, belowItem),
      assistantSpacing,
      completedFooter,
      toolSequence: getToolSequence({ item, aboveItem, belowItem }),
      isFirstInUserGroup: item.kind === "user_message" && aboveItem?.kind !== "user_message",
      isLastInUserGroup: item.kind === "user_message" && belowItem?.kind !== "user_message",
      isLastInToolSequence: isToolSequenceItem(item) && !isToolSequenceItem(belowItem),
      frameOrder: input.frameOrder,
    };
  });
}

// Keyed by history array identity; inner key encodes the inputs that affect history layout.
// History layout is stable across text-chunk flushes because the liveHead boundary item's
// kind and id don't change when only its text grows.
const historyLayoutCache = new WeakMap<StreamItem[], Map<string, StreamLayoutItem[]>>();

export function layoutStream(input: StreamLayoutInput): StreamLayout {
  const auxiliaryTurnFooter = resolveAuxiliaryTurnFooter(input);
  const historyBoundaryIndex = input.strategy.getHistoryLiveBoundaryIndex(input.history);
  const liveHeadBoundaryIndex = input.strategy.getLiveHeadHistoryBoundaryIndex(input.liveHead);
  const historyBoundaryItem =
    historyBoundaryIndex === null ? null : (input.history[historyBoundaryIndex] ?? null);
  const liveHeadBoundaryItem =
    liveHeadBoundaryIndex === null ? null : (input.liveHead[liveHeadBoundaryIndex] ?? null);
  const frameOrder = input.strategy.getFrameChildOrder();

  let history: StreamLayoutItem[];
  if (input.history.length > 0) {
    // The cache key encodes every input that can change history layout. liveHeadBoundaryItem.id
    // and .kind are stable across text-only flushes (text growth doesn't change what kind of
    // item borders history), so cached layout stays valid between flushes.
    const historyCacheKey = [
      input.agentStatus,
      frameOrder,
      historyBoundaryIndex ?? "null",
      liveHeadBoundaryItem?.id ?? "null",
      liveHeadBoundaryItem?.kind ?? "null",
      auxiliaryTurnFooter?.itemId ?? "null",
    ].join(":");
    let byKey = historyLayoutCache.get(input.history);
    if (!byKey) {
      byKey = new Map();
      historyLayoutCache.set(input.history, byKey);
    }
    const cached = byKey.get(historyCacheKey);
    if (cached) {
      history = cached;
    } else {
      history = layoutSegment({
        strategy: input.strategy,
        agentStatus: input.agentStatus,
        items: input.history,
        timingByAssistantId: input.timingByAssistantId,
        auxiliaryTurnFooter,
        frameOrder,
        boundaryIndex: historyBoundaryIndex,
        boundaryAboveItem: null,
        boundaryBelowItem: liveHeadBoundaryItem,
      });
      byKey.set(historyCacheKey, history);
    }
  } else {
    history = [];
  }

  const liveHead = layoutSegment({
    strategy: input.strategy,
    agentStatus: input.agentStatus,
    items: input.liveHead,
    timingByAssistantId: input.timingByAssistantId,
    auxiliaryTurnFooter,
    frameOrder,
    boundaryIndex: liveHeadBoundaryIndex,
    boundaryAboveItem: historyBoundaryItem,
    boundaryBelowItem: null,
  });

  return {
    history,
    liveHead,
    auxiliaryTurnFooter,
  };
}
