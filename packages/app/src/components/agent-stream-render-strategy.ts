import type { ComponentType, ReactElement, RefObject } from "react";
import type { FlatList, ScrollView, StyleProp, View, ViewStyle } from "react-native";
import type { StreamItem } from "@/types/stream";

type EdgeSlot = "header" | "footer";
type NeighborRelation = "above" | "below";
type AssistantTurnTraversalStep = -1 | 1;

export type MaintainVisibleContentPositionConfig = Readonly<{
  minIndexForVisible: number;
  autoscrollToTopThreshold: number;
}>;

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

export type StreamRenderRefs = {
  flatListRef: RefObject<FlatList<StreamItem> | null>;
  scrollViewRef: RefObject<ScrollView | null>;
  bottomAnchorRef: RefObject<View | null>;
};

export type ResolveStreamRenderStrategyInput = {
  platform: string;
  isMobileBreakpoint: boolean;
};

export interface StreamRenderStrategy {
  orderTail: (streamItems: StreamItem[]) => StreamItem[];
  orderHead: (streamHead: StreamItem[]) => StreamItem[];
  getNeighborIndex: (index: number, relation: NeighborRelation) => number;
  getNeighborItem: (
    items: StreamItem[],
    index: number,
    relation: NeighborRelation
  ) => StreamItem | undefined;
  collectAssistantTurnContent: (items: StreamItem[], startIndex: number) => string;
  isNearBottom: (input: StreamNearBottomInput) => boolean;
  getBottomOffset: (metrics: StreamViewportMetrics) => number;
  getEdgeSlotProps: (
    component: ReactElement | ComponentType<any> | null,
    gapSize: number
  ) => StreamEdgeSlotProps;
  getMaintainVisibleContentPosition: () =>
    | MaintainVisibleContentPositionConfig
    | undefined;
  getFlatListInverted: () => boolean;
  getOverlayScrollbarInverted: () => boolean;
  shouldDisableParentScrollOnInlineDetailsExpansion: () => boolean;
  shouldAnchorBottomOnContentSizeChange: () => boolean;
  shouldAnimateManualScrollToBottom: () => boolean;
  shouldUseVirtualizedList: () => boolean;
  scrollToBottom: (params: {
    refs: StreamRenderRefs;
    metrics: StreamViewportMetrics;
    animated: boolean;
  }) => void;
  scrollToOffset: (params: {
    refs: StreamRenderRefs;
    offset: number;
    animated: boolean;
  }) => void;
}

type StreamRenderStrategyConfig = {
  orderTailReverse: boolean;
  orderHeadReverse: boolean;
  assistantTurnTraversalStep: AssistantTurnTraversalStep;
  edgeSlot: EdgeSlot;
  flatListInverted: boolean;
  overlayScrollbarInverted: boolean;
  maintainVisibleContentPosition?: MaintainVisibleContentPositionConfig;
  disableParentScrollOnInlineDetailsExpansion: boolean;
  anchorBottomOnContentSizeChange: boolean;
  animateManualScrollToBottom: boolean;
  useVirtualizedList: boolean;
  isNearBottom: (input: StreamNearBottomInput) => boolean;
  getBottomOffset: (metrics: StreamViewportMetrics) => number;
  scrollToBottom: (params: {
    refs: StreamRenderRefs;
    metrics: StreamViewportMetrics;
    animated: boolean;
  }) => void;
  scrollToOffset: (params: {
    refs: StreamRenderRefs;
    offset: number;
    animated: boolean;
  }) => void;
};

const DEFAULT_MAINTAIN_VISIBLE_CONTENT_POSITION: MaintainVisibleContentPositionConfig =
  Object.freeze({
    minIndexForVisible: 0,
    autoscrollToTopThreshold: 0,
  });

function scrollAnchorIntoView(params: {
  refs: StreamRenderRefs;
  animated: boolean;
}): boolean {
  const anchorHandle = params.refs.bottomAnchorRef.current as
    | ({ getNativeRef?: () => unknown; scrollIntoView?: (options?: unknown) => void } &
        object)
    | null;
  if (!anchorHandle) {
    return false;
  }

  const maybeNative =
    typeof anchorHandle.getNativeRef === "function"
      ? anchorHandle.getNativeRef()
      : anchorHandle;

  const domElement = maybeNative as { scrollIntoView?: (options?: unknown) => void };
  if (typeof domElement.scrollIntoView !== "function") {
    return false;
  }

  domElement.scrollIntoView({
    block: "end",
    behavior: params.animated ? "smooth" : "auto",
  });
  return true;
}

function createStreamRenderStrategy(
  config: StreamRenderStrategyConfig
): StreamRenderStrategy {
  return {
    orderTail: (streamItems) =>
      config.orderTailReverse ? [...streamItems].reverse() : streamItems,
    orderHead: (streamHead) =>
      config.orderHeadReverse ? [...streamHead].reverse() : streamHead,
    getNeighborIndex: (index, relation) =>
      relation === "above"
        ? index + config.assistantTurnTraversalStep
        : index - config.assistantTurnTraversalStep,
    getNeighborItem: (items, index, relation) => {
      const neighborIndex =
        relation === "above"
          ? index + config.assistantTurnTraversalStep
          : index - config.assistantTurnTraversalStep;
      if (neighborIndex < 0 || neighborIndex >= items.length) {
        return undefined;
      }
      return items[neighborIndex];
    },
    collectAssistantTurnContent: (items, startIndex) => {
      const messages: string[] = [];
      for (
        let index = startIndex;
        index >= 0 && index < items.length;
        index += config.assistantTurnTraversalStep
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
    },
    isNearBottom: (input) => config.isNearBottom(input),
    getBottomOffset: (metrics) => config.getBottomOffset(metrics),
    getEdgeSlotProps: (component, gapSize) => {
      if (config.edgeSlot === "header") {
        return {
          ListHeaderComponent: component,
          ListHeaderComponentStyle: { marginBottom: gapSize },
        };
      }
      return {
        ListFooterComponent: component,
        ListFooterComponentStyle: { marginTop: gapSize },
      };
    },
    getMaintainVisibleContentPosition: () => config.maintainVisibleContentPosition,
    getFlatListInverted: () => config.flatListInverted,
    getOverlayScrollbarInverted: () => config.overlayScrollbarInverted,
    shouldDisableParentScrollOnInlineDetailsExpansion: () =>
      config.disableParentScrollOnInlineDetailsExpansion,
    shouldAnchorBottomOnContentSizeChange: () =>
      config.anchorBottomOnContentSizeChange,
    shouldAnimateManualScrollToBottom: () => config.animateManualScrollToBottom,
    shouldUseVirtualizedList: () => config.useVirtualizedList,
    scrollToBottom: (params) => config.scrollToBottom(params),
    scrollToOffset: (params) => config.scrollToOffset(params),
  };
}

function createInvertedStreamStrategy(): StreamRenderStrategy {
  return createStreamRenderStrategy({
    orderTailReverse: true,
    orderHeadReverse: true,
    assistantTurnTraversalStep: 1,
    edgeSlot: "header",
    flatListInverted: true,
    overlayScrollbarInverted: true,
    maintainVisibleContentPosition: DEFAULT_MAINTAIN_VISIBLE_CONTENT_POSITION,
    disableParentScrollOnInlineDetailsExpansion: false,
    anchorBottomOnContentSizeChange: false,
    animateManualScrollToBottom: true,
    useVirtualizedList: true,
    isNearBottom: (input) => input.offsetY <= input.threshold,
    getBottomOffset: () => 0,
    scrollToBottom: ({ refs, animated }) => {
      refs.flatListRef.current?.scrollToOffset({
        offset: 0,
        animated,
      });
    },
    scrollToOffset: ({ refs, offset, animated }) => {
      refs.flatListRef.current?.scrollToOffset({ offset, animated });
    },
  });
}

function createForwardStreamStrategy(): StreamRenderStrategy {
  return createStreamRenderStrategy({
    orderTailReverse: false,
    orderHeadReverse: false,
    assistantTurnTraversalStep: -1,
    edgeSlot: "footer",
    flatListInverted: false,
    overlayScrollbarInverted: false,
    maintainVisibleContentPosition: undefined,
    disableParentScrollOnInlineDetailsExpansion: false,
    anchorBottomOnContentSizeChange: true,
    animateManualScrollToBottom: false,
    useVirtualizedList: false,
    isNearBottom: (inputMetrics) => {
      const distanceFromBottom = Math.max(
        0,
        inputMetrics.contentHeight -
          (inputMetrics.offsetY + inputMetrics.viewportHeight)
      );
      return distanceFromBottom <= inputMetrics.threshold;
    },
    getBottomOffset: (metrics) =>
      Math.max(0, metrics.contentHeight - metrics.viewportHeight),
    scrollToBottom: ({ refs, metrics, animated }) => {
      if (scrollAnchorIntoView({ refs, animated })) {
        return;
      }
      refs.scrollViewRef.current?.scrollToEnd?.({ animated });
      refs.scrollViewRef.current?.scrollTo?.({
        y: Math.max(0, metrics.contentHeight - metrics.viewportHeight),
        animated,
      });
    },
    scrollToOffset: ({ refs, offset, animated }) => {
      refs.scrollViewRef.current?.scrollTo({ y: offset, animated });
    },
  });
}

export function resolveStreamRenderStrategy(
  input: ResolveStreamRenderStrategyInput
): StreamRenderStrategy {
  if (input.platform === "web") {
    return createForwardStreamStrategy();
  }
  return createInvertedStreamStrategy();
}

export function orderTailForStreamRenderStrategy(params: {
  strategy: StreamRenderStrategy;
  streamItems: StreamItem[];
}): StreamItem[] {
  return params.strategy.orderTail(params.streamItems);
}

export function orderHeadForStreamRenderStrategy(params: {
  strategy: StreamRenderStrategy;
  streamHead: StreamItem[];
}): StreamItem[] {
  return params.strategy.orderHead(params.streamHead);
}

export function getStreamNeighborIndex(params: {
  strategy: StreamRenderStrategy;
  index: number;
  relation: NeighborRelation;
}): number {
  return params.strategy.getNeighborIndex(params.index, params.relation);
}

export function getStreamNeighborItem(params: {
  strategy: StreamRenderStrategy;
  items: StreamItem[];
  index: number;
  relation: NeighborRelation;
}): StreamItem | undefined {
  return params.strategy.getNeighborItem(
    params.items,
    params.index,
    params.relation
  );
}

export function collectAssistantTurnContentForStreamRenderStrategy(params: {
  strategy: StreamRenderStrategy;
  items: StreamItem[];
  startIndex: number;
}): string {
  return params.strategy.collectAssistantTurnContent(
    params.items,
    params.startIndex
  );
}

export function isNearBottomForStreamRenderStrategy(
  params: StreamNearBottomInput & { strategy: StreamRenderStrategy }
): boolean {
  return params.strategy.isNearBottom({
    offsetY: params.offsetY,
    threshold: params.threshold,
    contentHeight: params.contentHeight,
    viewportHeight: params.viewportHeight,
  });
}

export function getBottomOffsetForStreamRenderStrategy(
  params: StreamViewportMetrics & {
    strategy: StreamRenderStrategy;
  }
): number {
  return params.strategy.getBottomOffset({
    contentHeight: params.contentHeight,
    viewportHeight: params.viewportHeight,
  });
}

export function getStreamEdgeSlotProps(params: {
  strategy: StreamRenderStrategy;
  component: ReactElement | ComponentType<any> | null;
  gapSize: number;
}): StreamEdgeSlotProps {
  return params.strategy.getEdgeSlotProps(params.component, params.gapSize);
}
