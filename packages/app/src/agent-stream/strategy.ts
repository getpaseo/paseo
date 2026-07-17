import type { ComponentType, ReactElement, ReactNode, RefObject } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import type { StreamItem } from "@/types/stream";
import type { StreamHistoryBoundary, StreamRenderSegments } from "./model";
import type {
  BottomAnchorLocalRequest,
  BottomAnchorRouteRequest,
} from "./bottom-anchor-controller";

type EdgeSlot = "header" | "footer";
type NeighborRelation = "above" | "below";
type AssistantTurnTraversalStep = -1 | 1;
export type StreamFrameChildOrder = "content-then-footer" | "footer-then-content";

export type MaintainVisibleContentPositionConfig = Readonly<{
  minIndexForVisible: number;
  autoscrollToTopThreshold: number;
}>;

export type BottomAnchorTransportBehavior = Readonly<{
  verificationDelayFrames: number;
  verificationRetryMode: "rescroll" | "recheck";
}>;

export interface StreamViewportMetrics {
  contentHeight: number;
  viewportHeight: number;
}

export type StreamNearBottomInput = StreamViewportMetrics & {
  offsetY: number;
  threshold: number;
};

export interface StreamEdgeSlotProps {
  ListHeaderComponent?: ReactElement | ComponentType<unknown> | null;
  ListHeaderComponentStyle?: StyleProp<ViewStyle>;
  ListFooterComponent?: ReactElement | ComponentType<unknown> | null;
  ListFooterComponentStyle?: StyleProp<ViewStyle>;
}

export interface StreamViewportHandle {
  scrollToBottom: (reason?: BottomAnchorLocalRequest["reason"]) => void;
  prepareForViewportChange: () => void;
  /**
   * Scrolls the given stream item into view, if it is currently reachable in
   * this strategy's rendered rows (history — virtualized or mounted). Returns
   * false without side effects when the item isn't found there; callers
   * should not report a scroll as having happened in that case.
   */
  scrollToItem: (itemId: string) => boolean;
  /** Adjust the current viewport position after a mounted search anchor is measured. */
  scrollBy: (deltaY: number) => void;
}

export interface StreamSegmentRenderers {
  renderHistoryVirtualizedRow: (item: StreamItem, index: number, items: StreamItem[]) => ReactNode;
  renderHistoryMountedRow: (item: StreamItem, index: number, items: StreamItem[]) => ReactNode;
  renderLiveHeadRow: (item: StreamItem, index: number, items: StreamItem[]) => ReactNode;
  renderLiveAuxiliary: () => ReactNode;
}

export interface StreamHistoryRowRevision {
  contentById: { has(id: string): boolean };
  displayStateById: { has(id: string): boolean };
  globalDisplayState: boolean;
}

export interface StreamRenderInput {
  agentId: string;
  segments: StreamRenderSegments;
  historyRowRevision?: StreamHistoryRowRevision;
  liveHeadRowRevision?: unknown;
  boundary: StreamHistoryBoundary;
  renderers: StreamSegmentRenderers;
  listEmptyComponent: ReactNode;
  viewportRef: RefObject<StreamViewportHandle | null>;
  routeBottomAnchorRequest: BottomAnchorRouteRequest | null;
  isAuthoritativeHistoryReady: boolean;
  onNearBottomChange: (value: boolean) => void;
  onNearHistoryStart: () => void;
  isLoadingOlderHistory: boolean;
  hasOlderHistory: boolean;
  scrollEnabled: boolean;
  listStyle: StyleProp<ViewStyle>;
  baseListContentContainerStyle: StyleProp<ViewStyle>;
  forwardListContentContainerStyle: StyleProp<ViewStyle>;
}

export interface ResolveStreamRenderStrategyInput {
  platform: string;
  isMobileBreakpoint: boolean;
}

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
    component: ReactElement | ComponentType<unknown> | null,
    gapSize: number,
  ) => StreamEdgeSlotProps;
  getMaintainVisibleContentPosition: () => MaintainVisibleContentPositionConfig | undefined;
  getBottomAnchorTransportBehavior: () => BottomAnchorTransportBehavior;
  getHistoryLiveBoundaryIndex: (history: StreamItem[]) => number | null;
  getLiveHeadHistoryBoundaryIndex: (liveHead: StreamItem[]) => number | null;
  getLatestItemIndex: (items: StreamItem[]) => number | null;
  getFrameChildOrder: () => StreamFrameChildOrder;
  getFlatListInverted: () => boolean;
  getOverlayScrollbarInverted: () => boolean;
  shouldDisableParentScrollOnInlineDetailsExpansion: () => boolean;
  shouldAnchorBottomOnContentSizeChange: () => boolean;
  shouldAnimateManualScrollToBottom: () => boolean;
  shouldUseVirtualizedList: () => boolean;
}

interface StreamStrategyConfig {
  render: StreamStrategy["render"];
  orderTailReverse: boolean;
  orderHeadReverse: boolean;
  assistantTurnTraversalStep: AssistantTurnTraversalStep;
  edgeSlot: EdgeSlot;
  historyLiveBoundaryEdge: "first" | "last";
  liveHeadHistoryBoundaryEdge: "first" | "last";
  frameChildOrder: StreamFrameChildOrder;
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
}

const NATIVE_SETTLING_VERIFICATION_DELAY_FRAMES = 4;

/**
 * Fraction of the viewport height used to vertically center a timeline-
 * search scroll target. Shared by the coarse row-centering stage
 * (`viewPosition` passed to FlatList#scrollToIndex in strategy-native's
 * scrollToItem) and the fine occurrence-anchor correction stage
 * (`targetCenterY` computed in agent-stream/view.tsx and consumed by
 * timeline-search/occurrence-anchor.tsx) so both stages agree on where
 * "centered" means instead of fighting each other with different targets.
 */
export const TIMELINE_SEARCH_SCROLL_CENTER_FRACTION = 0.5;

export function createStreamStrategy(config: StreamStrategyConfig): StreamStrategy {
  return {
    render: config.render,
    orderTail: (streamItems) =>
      config.orderTailReverse ? [...streamItems].toReversed() : streamItems,
    orderHead: (streamHead) =>
      config.orderHeadReverse ? [...streamHead].toReversed() : streamHead,
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
      return messages.toReversed().join("\n\n");
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
    getHistoryLiveBoundaryIndex: (history) => {
      if (history.length === 0) {
        return null;
      }
      return config.historyLiveBoundaryEdge === "first" ? 0 : history.length - 1;
    },
    getLiveHeadHistoryBoundaryIndex: (liveHead) => {
      if (liveHead.length === 0) {
        return null;
      }
      return config.liveHeadHistoryBoundaryEdge === "first" ? 0 : liveHead.length - 1;
    },
    getLatestItemIndex: (items) => {
      if (items.length === 0) {
        return null;
      }
      return config.historyLiveBoundaryEdge === "first" ? 0 : items.length - 1;
    },
    getFrameChildOrder: () => config.frameChildOrder,
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
  component: ReactElement | ComponentType<unknown> | null;
  gapSize: number;
}): StreamEdgeSlotProps {
  return params.strategy.getEdgeSlotProps(params.component, params.gapSize);
}

export function getHistoryLiveBoundaryIndexForStreamRenderStrategy(params: {
  strategy: StreamStrategy;
  history: StreamItem[];
}): number | null {
  return params.strategy.getHistoryLiveBoundaryIndex(params.history);
}

export function getLiveHeadHistoryBoundaryIndexForStreamRenderStrategy(params: {
  strategy: StreamStrategy;
  liveHead: StreamItem[];
}): number | null {
  return params.strategy.getLiveHeadHistoryBoundaryIndex(params.liveHead);
}

export function getFrameChildOrderForStreamRenderStrategy(params: {
  strategy: StreamStrategy;
}): StreamFrameChildOrder {
  return params.strategy.getFrameChildOrder();
}
