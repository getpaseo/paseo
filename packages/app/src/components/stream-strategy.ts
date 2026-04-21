import type { ComponentType, ReactElement, ReactNode, RefObject } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import type { StreamItem } from "@/types/stream";
import type { StreamHistoryBoundary, StreamRenderSegments } from "./agent-stream-render-model";
import type {
  BottomAnchorLocalRequest,
  BottomAnchorRouteRequest,
} from "./use-bottom-anchor-controller";

type EdgeSlot = "header" | "footer";
type NeighborRelation = "above" | "below";
type AssistantTurnTraversalStep = -1 | 1;

export type MaintainVisibleContentPositionConfig = Readonly<{
  minIndexForVisible: number;
  autoscrollToTopThreshold: number;
}>;

export type BottomAnchorTransportBehavior = Readonly<{
  verificationDelayFrames: number;
  verificationRetryMode: "rescroll" | "recheck";
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

export type StreamViewportHandle = {
  scrollToBottom: (reason?: BottomAnchorLocalRequest["reason"]) => void;
  prepareForViewportChange: () => void;
};

export type StreamSegmentRenderers = {
  renderHistoryVirtualizedRow: (item: StreamItem, index: number, items: StreamItem[]) => ReactNode;
  renderHistoryMountedRow: (item: StreamItem, index: number, items: StreamItem[]) => ReactNode;
  renderLiveHeadRow: (item: StreamItem, index: number, items: StreamItem[]) => ReactNode;
  renderLiveAuxiliary: () => ReactNode;
};

export type StreamRenderInput = {
  agentId: string;
  segments: StreamRenderSegments;
  boundary: StreamHistoryBoundary;
  renderers: StreamSegmentRenderers;
  listEmptyComponent: ReactNode;
  viewportRef: RefObject<StreamViewportHandle | null>;
  routeBottomAnchorRequest: BottomAnchorRouteRequest | null;
  isAuthoritativeHistoryReady: boolean;
  onNearBottomChange: (value: boolean) => void;
  scrollEnabled: boolean;
  listStyle: StyleProp<ViewStyle>;
  baseListContentContainerStyle: StyleProp<ViewStyle>;
  forwardListContentContainerStyle: StyleProp<ViewStyle>;
};

export type ResolveStreamRenderStrategyInput = {
  platform: string;
  isMobileBreakpoint: boolean;
};

export interface StreamStrategy {
  render: (input: StreamRenderInput) => ReactNode;
  orderTail: (streamItems: StreamItem[]) => StreamItem[];
  orderHead: (streamHead: StreamItem[]) => StreamItem[];
  getNeighborIndex: (index: number, relation: NeighborRelation) => number;
  getNeighborItem: (
    items: StreamItem[],
    index: number,
    relation: NeighborRelation,
  ) => StreamItem | undefined;
  collectAssistantTurnContent: (items: StreamItem[], startIndex: number) => string;
  isNearBottom: (input: StreamNearBottomInput) => boolean;
  getBottomOffset: (metrics: StreamViewportMetrics) => number;
  getEdgeSlotProps: (
    component: ReactElement | ComponentType<any> | null,
    gapSize: number,
  ) => StreamEdgeSlotProps;
  getMaintainVisibleContentPosition: () => MaintainVisibleContentPositionConfig | undefined;
  getBottomAnchorTransportBehavior: () => BottomAnchorTransportBehavior;
  getFlatListInverted: () => boolean;
  getOverlayScrollbarInverted: () => boolean;
  shouldDisableParentScrollOnInlineDetailsExpansion: () => boolean;
  shouldAnchorBottomOnContentSizeChange: () => boolean;
  shouldAnimateManualScrollToBottom: () => boolean;
  shouldUseVirtualizedList: () => boolean;
}

type StreamStrategyConfig = {
  render: StreamStrategy["render"];
  orderTailReverse: boolean;
  orderHeadReverse: boolean;
  assistantTurnTraversalStep: AssistantTurnTraversalStep;
  edgeSlot: EdgeSlot;
  flatListInverted: boolean;
  overlayScrollbarInverted: boolean;
  maintainVisibleContentPosition?: MaintainVisibleContentPositionConfig;
  bottomAnchorTransportBehavior: BottomAnchorTransportBehavior;
  disableParentScrollOnInlineDetailsExpansion: boolean;
  anchorBottomOnContentSizeChange: boolean;
  animateManualScrollToBottom: boolean;
  useVirtualizedList: boolean;
  isNearBottom: (input: StreamNearBottomInput) => boolean;
  getBottomOffset: (metrics: StreamViewportMetrics) => number;
};

const NATIVE_SETTLING_VERIFICATION_DELAY_FRAMES = 4;

export function createStreamStrategy(config: StreamStrategyConfig): StreamStrategy {
  return {
    render: config.render,
    orderTail: (streamItems) =>
      config.orderTailReverse ? [...streamItems].reverse() : streamItems,
    orderHead: (streamHead) => (config.orderHeadReverse ? [...streamHead].reverse() : streamHead),
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
    getBottomAnchorTransportBehavior: () => config.bottomAnchorTransportBehavior,
    getFlatListInverted: () => config.flatListInverted,
    getOverlayScrollbarInverted: () => config.overlayScrollbarInverted,
    shouldDisableParentScrollOnInlineDetailsExpansion: () =>
      config.disableParentScrollOnInlineDetailsExpansion,
    shouldAnchorBottomOnContentSizeChange: () => config.anchorBottomOnContentSizeChange,
    shouldAnimateManualScrollToBottom: () => config.animateManualScrollToBottom,
    shouldUseVirtualizedList: () => config.useVirtualizedList,
  };
}

export function resolveBottomAnchorTransportBehavior(input: {
  strategy: StreamStrategy;
  isViewportSettling: boolean;
}): BottomAnchorTransportBehavior {
  const baseBehavior = input.strategy.getBottomAnchorTransportBehavior();
  if (!input.isViewportSettling || !input.strategy.getFlatListInverted()) {
    return baseBehavior;
  }
  return {
    verificationDelayFrames: Math.max(
      baseBehavior.verificationDelayFrames,
      NATIVE_SETTLING_VERIFICATION_DELAY_FRAMES,
    ),
    verificationRetryMode: "recheck",
  };
}

export function orderTailForStreamRenderStrategy(params: {
  strategy: StreamStrategy;
  streamItems: StreamItem[];
}): StreamItem[] {
  return params.strategy.orderTail(params.streamItems);
}

export function orderHeadForStreamRenderStrategy(params: {
  strategy: StreamStrategy;
  streamHead: StreamItem[];
}): StreamItem[] {
  return params.strategy.orderHead(params.streamHead);
}

export function getStreamNeighborIndex(params: {
  strategy: StreamStrategy;
  index: number;
  relation: NeighborRelation;
}): number {
  return params.strategy.getNeighborIndex(params.index, params.relation);
}

export function getStreamNeighborItem(params: {
  strategy: StreamStrategy;
  items: StreamItem[];
  index: number;
  relation: NeighborRelation;
}): StreamItem | undefined {
  return params.strategy.getNeighborItem(params.items, params.index, params.relation);
}

export function collectAssistantTurnContentForStreamRenderStrategy(params: {
  strategy: StreamStrategy;
  items: StreamItem[];
  startIndex: number;
}): string {
  return params.strategy.collectAssistantTurnContent(params.items, params.startIndex);
}

export function isNearBottomForStreamRenderStrategy(
  params: StreamNearBottomInput & { strategy: StreamStrategy },
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
    strategy: StreamStrategy;
  },
): number {
  return params.strategy.getBottomOffset({
    contentHeight: params.contentHeight,
    viewportHeight: params.viewportHeight,
  });
}

export function getStreamEdgeSlotProps(params: {
  strategy: StreamStrategy;
  component: ReactElement | ComponentType<any> | null;
  gapSize: number;
}): StreamEdgeSlotProps {
  return params.strategy.getEdgeSlotProps(params.component, params.gapSize);
}
