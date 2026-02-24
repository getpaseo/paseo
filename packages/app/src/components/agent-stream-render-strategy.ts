import type { ComponentType, ReactElement } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import type { StreamItem } from "@/types/stream";

type EdgeSlot = "header" | "footer";
type NeighborRelation = "above" | "below";
type AssistantTurnTraversalStep = -1 | 1;

export type MaintainVisibleContentPositionConfig = Readonly<{
  minIndexForVisible: number;
  autoscrollToTopThreshold: number;
}>;

type StreamRenderStrategyBase = {
  kind: "inverted_stream" | "forward_stream";
  flatListInverted: boolean;
  edgeSlot: EdgeSlot;
  overlayScrollbarInverted: boolean;
  maintainVisibleContentPosition?: MaintainVisibleContentPositionConfig;
  assistantTurnTraversalStep: AssistantTurnTraversalStep;
  disableParentScrollOnInlineDetailsExpansion: boolean;
};

export type InvertedStreamRenderStrategy = StreamRenderStrategyBase & {
  kind: "inverted_stream";
  flatListInverted: true;
  edgeSlot: "header";
  overlayScrollbarInverted: true;
  maintainVisibleContentPosition: MaintainVisibleContentPositionConfig;
  assistantTurnTraversalStep: 1;
  disableParentScrollOnInlineDetailsExpansion: false;
};

export type ForwardStreamRenderStrategy = StreamRenderStrategyBase & {
  kind: "forward_stream";
  flatListInverted: false;
  edgeSlot: "footer";
  overlayScrollbarInverted: false;
  maintainVisibleContentPosition?: undefined;
  assistantTurnTraversalStep: -1;
};

export type StreamRenderStrategy =
  | InvertedStreamRenderStrategy
  | ForwardStreamRenderStrategy;

export type ResolveStreamRenderStrategyInput = {
  platform: string;
  isMobileBreakpoint: boolean;
};

export type StreamViewportMetrics = {
  contentHeight: number;
  viewportHeight: number;
};

export type StreamNearBottomInput = StreamViewportMetrics & {
  offsetY: number;
  threshold: number;
};

export type StreamEdgeSlotProps = {
  ListHeaderComponent?: ReactElement | ComponentType<any> | null;
  ListHeaderComponentStyle?: StyleProp<ViewStyle>;
  ListFooterComponent?: ReactElement | ComponentType<any> | null;
  ListFooterComponentStyle?: StyleProp<ViewStyle>;
};

const DEFAULT_MAINTAIN_VISIBLE_CONTENT_POSITION: MaintainVisibleContentPositionConfig =
  Object.freeze({
    minIndexForVisible: 0,
    autoscrollToTopThreshold: 0,
  });

const INVERTED_STREAM_STRATEGY: InvertedStreamRenderStrategy = {
  kind: "inverted_stream",
  flatListInverted: true,
  edgeSlot: "header",
  overlayScrollbarInverted: true,
  maintainVisibleContentPosition: DEFAULT_MAINTAIN_VISIBLE_CONTENT_POSITION,
  assistantTurnTraversalStep: 1,
  disableParentScrollOnInlineDetailsExpansion: false,
};

const FORWARD_STREAM_STRATEGY_DESKTOP: ForwardStreamRenderStrategy = {
  kind: "forward_stream",
  flatListInverted: false,
  edgeSlot: "footer",
  overlayScrollbarInverted: false,
  assistantTurnTraversalStep: -1,
  disableParentScrollOnInlineDetailsExpansion: true,
};

const FORWARD_STREAM_STRATEGY_MOBILE: ForwardStreamRenderStrategy = {
  ...FORWARD_STREAM_STRATEGY_DESKTOP,
  disableParentScrollOnInlineDetailsExpansion: false,
};

export function resolveStreamRenderStrategy(
  input: ResolveStreamRenderStrategyInput
): StreamRenderStrategy {
  if (input.platform === "web") {
    return input.isMobileBreakpoint
      ? FORWARD_STREAM_STRATEGY_MOBILE
      : FORWARD_STREAM_STRATEGY_DESKTOP;
  }
  return INVERTED_STREAM_STRATEGY;
}

export function orderTailForStreamRenderStrategy(params: {
  strategy: StreamRenderStrategy;
  streamItems: StreamItem[];
}): StreamItem[] {
  const { strategy, streamItems } = params;
  return strategy.kind === "inverted_stream"
    ? [...streamItems].reverse()
    : streamItems;
}

export function orderHeadForStreamRenderStrategy(params: {
  strategy: StreamRenderStrategy;
  streamHead: StreamItem[];
}): StreamItem[] {
  const { strategy, streamHead } = params;
  return strategy.kind === "inverted_stream"
    ? [...streamHead].reverse()
    : streamHead;
}

export function getStreamNeighborIndex(params: {
  strategy: StreamRenderStrategy;
  index: number;
  relation: NeighborRelation;
}): number {
  const { strategy, index, relation } = params;
  if (strategy.kind === "inverted_stream") {
    return relation === "above" ? index + 1 : index - 1;
  }
  return relation === "above" ? index - 1 : index + 1;
}

export function getStreamNeighborItem(params: {
  strategy: StreamRenderStrategy;
  items: StreamItem[];
  index: number;
  relation: NeighborRelation;
}): StreamItem | undefined {
  const nextIndex = getStreamNeighborIndex(params);
  if (nextIndex < 0 || nextIndex >= params.items.length) {
    return undefined;
  }
  return params.items[nextIndex];
}

export function collectAssistantTurnContentForStreamRenderStrategy(params: {
  strategy: StreamRenderStrategy;
  items: StreamItem[];
  startIndex: number;
}): string {
  const { strategy, items, startIndex } = params;
  const messages: string[] = [];

  for (
    let index = startIndex;
    index >= 0 && index < items.length;
    index += strategy.assistantTurnTraversalStep
  ) {
    const currentItem = items[index];
    if (currentItem.kind === "user_message") {
      break;
    }
    if (currentItem.kind === "assistant_message") {
      messages.push(currentItem.text);
    }
  }

  return messages.reverse().join("\n\n");
}

export function isNearBottomForStreamRenderStrategy(
  params: StreamNearBottomInput & { strategy: StreamRenderStrategy }
): boolean {
  const { strategy, threshold, offsetY } = params;
  if (strategy.kind === "inverted_stream") {
    return offsetY <= threshold;
  }

  const distanceFromBottom = Math.max(
    0,
    params.contentHeight - (offsetY + params.viewportHeight)
  );
  return distanceFromBottom <= threshold;
}

export function getBottomOffsetForStreamRenderStrategy(params: StreamViewportMetrics & {
  strategy: StreamRenderStrategy;
}): number {
  const { strategy } = params;
  if (strategy.kind === "inverted_stream") {
    return 0;
  }
  return Math.max(0, params.contentHeight - params.viewportHeight);
}

export function getStreamEdgeSlotProps(params: {
  strategy: StreamRenderStrategy;
  component: ReactElement | ComponentType<any> | null;
  gapSize: number;
}): StreamEdgeSlotProps {
  const { strategy, component, gapSize } = params;
  if (strategy.edgeSlot === "header") {
    return {
      ListHeaderComponent: component,
      ListHeaderComponentStyle: { marginBottom: gapSize },
    };
  }
  return {
    ListFooterComponent: component,
    ListFooterComponentStyle: { marginTop: gapSize },
  };
}
