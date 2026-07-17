import React, {
  Fragment,
  type ReactElement,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  FlatList,
  ActivityIndicator,
  Keyboard,
  View,
  type LayoutChangeEvent,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import type { StreamItem } from "@/types/stream";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useBottomAnchorController } from "./bottom-anchor-controller";
import type { StreamRenderInput, StreamStrategy, StreamViewportHandle } from "./strategy";
import {
  createStreamStrategy,
  isNearBottomForStreamRenderStrategy,
  resolveBottomAnchorTransportBehavior,
  TIMELINE_SEARCH_SCROLL_CENTER_FRACTION,
} from "./strategy";

/**
 * Wraps FlatList#scrollToIndex with a try/catch — RN can throw synchronously
 * for an index outside the currently measured range. Shared by the direct
 * scrollToItem call below and by the async onScrollToIndexFailed retry,
 * which is otherwise the one call site in this file that previously had no
 * guard and could crash if the rows shrank between the failure callback
 * firing and the retry running.
 */
function tryScrollToIndex(
  flatListRef: RefObject<FlatList<StreamItem> | null>,
  index: number,
  animated: boolean,
): void {
  try {
    flatListRef.current?.scrollToIndex({
      index,
      animated,
      viewPosition: TIMELINE_SEARCH_SCROLL_CENTER_FRACTION,
    });
  } catch {
    // Swallow synchronous out-of-range errors. If this call IS itself the
    // onScrollToIndexFailed retry, there's nothing further to recover with —
    // RN will fire onScrollToIndexFailed again if it detects another one.
  }
}

const DEFAULT_MAINTAIN_VISIBLE_CONTENT_POSITION = Object.freeze({
  minIndexForVisible: 0,
  autoscrollToTopThreshold: 0,
});
const HISTORY_START_THRESHOLD_PX = 96;

interface HistoryRowDisplayVariants {
  regular?: StreamItem;
  compact?: StreamItem;
}

const historyRowDisplayVariants = new WeakMap<StreamItem, HistoryRowDisplayVariants>();

function getHistoryRowDisplayVariant(item: StreamItem, compact: boolean): StreamItem {
  let variants = historyRowDisplayVariants.get(item);
  if (!variants) {
    variants = {};
    historyRowDisplayVariants.set(item, variants);
  }
  const key = compact ? "compact" : "regular";
  variants[key] ??= { ...item };
  return variants[key];
}

function keyExtractor(item: { id: string }): string {
  return item.id;
}

function NativeStreamViewport(props: StreamRenderInput & { strategy: StreamStrategy }) {
  const {
    agentId,
    segments,
    historyRowRevision,
    liveHeadRowRevision,
    boundary,
    renderers,
    listEmptyComponent,
    viewportRef,
    routeBottomAnchorRequest,
    isAuthoritativeHistoryReady,
    onNearBottomChange,
    onNearHistoryStart,
    isLoadingOlderHistory,
    hasOlderHistory,
    scrollEnabled,
    listStyle,
    baseListContentContainerStyle,
    strategy,
  } = props;
  const { renderHistoryMountedRow, renderLiveHeadRow, renderLiveAuxiliary } = renderers;
  const flatListRef = useRef<FlatList<StreamItem>>(null);
  const streamViewportMetricsRef = useRef({
    containerKey: "native-virtualized",
    contentHeight: 0,
    viewportWidth: 0,
    viewportHeight: 0,
    offsetY: 0,
    viewportMeasuredForKey: null as string | null,
    contentMeasuredForKey: null as string | null,
  });
  const scrollOffsetYRef = useRef(0);
  const programmaticScrollEventBudgetRef = useRef(0);
  const scrollToIndexRecoveryFrameRef = useRef<number | null>(null);
  const [isNativeViewportSettling, setIsNativeViewportSettling] = useState(false);
  const nativeViewportSettlingFrameIdRef = useRef<number | null>(null);
  const historyStartReadyRef = useRef(false);

  const historyItems = useMemo(() => {
    if (segments.historyVirtualized.length === 0) {
      return segments.historyMounted;
    }
    return [...segments.historyVirtualized, ...segments.historyMounted];
  }, [segments.historyMounted, segments.historyVirtualized]);
  // Keep unchanged item identities intact so live updates only rerender rows
  // whose projected content or local display state actually changed. A rare
  // breakpoint change intentionally refreshes the whole history window.
  const globallyRevisedHistoryRows = useMemo(() => {
    const globalDisplayState = historyRowRevision?.globalDisplayState ?? false;
    return historyItems.map((item) => getHistoryRowDisplayVariant(item, globalDisplayState));
  }, [historyItems, historyRowRevision?.globalDisplayState]);
  const displayStateHistoryRows = useMemo(
    () =>
      globallyRevisedHistoryRows.map((item) =>
        historyRowRevision?.displayStateById.has(item.id) ? { ...item } : item,
      ),
    [globallyRevisedHistoryRows, historyRowRevision?.displayStateById],
  );
  const historyRows = useMemo(
    () =>
      displayStateHistoryRows.map((item) =>
        historyRowRevision?.contentById.has(item.id) ? { ...item } : item,
      ),
    [displayStateHistoryRows, historyRowRevision?.contentById],
  );
  // Read from the handle's scrollToItem, which must not go stale between the
  // renders that rebuild `historyRows` and the effect that registers the handle.
  const historyRowsRef = useRef(historyRows);
  historyRowsRef.current = historyRows;

  const clearNativeViewportSettling = useCallback(() => {
    if (nativeViewportSettlingFrameIdRef.current !== null) {
      cancelAnimationFrame(nativeViewportSettlingFrameIdRef.current);
      nativeViewportSettlingFrameIdRef.current = null;
    }
  }, []);

  const markNativeViewportSettling = useCallback(() => {
    clearNativeViewportSettling();
    setIsNativeViewportSettling(true);
    let remainingFrames = 4;
    const tick = () => {
      if (remainingFrames <= 0) {
        nativeViewportSettlingFrameIdRef.current = null;
        setIsNativeViewportSettling(false);
        return;
      }
      remainingFrames -= 1;
      nativeViewportSettlingFrameIdRef.current = requestAnimationFrame(tick);
    };
    nativeViewportSettlingFrameIdRef.current = requestAnimationFrame(tick);
  }, [clearNativeViewportSettling]);

  const bottomAnchorTransportBehavior = useMemo(
    () =>
      resolveBottomAnchorTransportBehavior({
        strategy,
        isViewportSettling: isNativeViewportSettling,
      }),
    [isNativeViewportSettling, strategy],
  );

  const scrollToBottom = useCallback(
    (animated: boolean) => {
      programmaticScrollEventBudgetRef.current = 3;
      flatListRef.current?.scrollToOffset({
        offset: 0,
        animated,
      });
      scrollOffsetYRef.current = 0;
      streamViewportMetricsRef.current = {
        ...streamViewportMetricsRef.current,
        offsetY: 0,
      };
      onNearBottomChange(true);
    },
    [onNearBottomChange],
  );

  const bottomAnchorController = useBottomAnchorController({
    agentId,
    routeRequest: routeBottomAnchorRequest,
    isAuthoritativeHistoryReady,
    renderStrategy: "inverted-stream",
    transportBehavior: bottomAnchorTransportBehavior,
    getMeasurementState: () => streamViewportMetricsRef.current,
    isNearBottom: () => {
      const metrics = streamViewportMetricsRef.current;
      return isNearBottomForStreamRenderStrategy({
        strategy,
        offsetY: metrics.offsetY,
        threshold: 32,
        contentHeight: metrics.contentHeight,
        viewportHeight: metrics.viewportHeight,
      });
    },
    scrollToBottom,
  });

  useEffect(() => {
    streamViewportMetricsRef.current = {
      containerKey: "native-virtualized",
      contentHeight: 0,
      viewportWidth: 0,
      viewportHeight: 0,
      offsetY: 0,
      viewportMeasuredForKey: null,
      contentMeasuredForKey: null,
    };
    scrollOffsetYRef.current = 0;
    clearNativeViewportSettling();
    setIsNativeViewportSettling(false);
    historyStartReadyRef.current = false;
    const frame = requestAnimationFrame(() => {
      historyStartReadyRef.current = true;
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [agentId, clearNativeViewportSettling]);

  useEffect(() => {
    const keyboardEvents = [
      "keyboardWillShow",
      "keyboardWillHide",
      "keyboardDidShow",
      "keyboardDidHide",
      "keyboardWillChangeFrame",
      "keyboardDidChangeFrame",
    ] as const;
    const subscriptions = keyboardEvents.map((eventName) =>
      Keyboard.addListener(eventName, () => {
        markNativeViewportSettling();
      }),
    );
    return () => {
      for (const subscription of subscriptions) {
        subscription.remove();
      }
      clearNativeViewportSettling();
    };
  }, [clearNativeViewportSettling, markNativeViewportSettling]);

  useEffect(() => {
    bottomAnchorController.prepareForStickyContentChange();
  }, [bottomAnchorController, historyRows, segments.liveHead]);

  useEffect(() => {
    const handle: StreamViewportHandle = {
      scrollToBottom: (reason = "jump-to-bottom") => {
        bottomAnchorController.requestLocalAnchor({
          agentId,
          reason,
        });
      },
      prepareForViewportChange: () => {
        bottomAnchorController.prepareForStickyViewportChange();
        markNativeViewportSettling();
      },
      scrollToItem: (itemId) => {
        const index = historyRowsRef.current.findIndex((row) => row.id === itemId);
        if (index === -1) {
          // Not reachable in the virtualized FlatList `data` — e.g. a row
          // that's still only in the live head. Unlike web's DOM-wide
          // querySelector fallback, native has no way to scroll to a row
          // that isn't part of the list's own index space.
          return false;
        }
        tryScrollToIndex(flatListRef, index, true);
        return true;
      },
      scrollBy: (deltaY) => {
        flatListRef.current?.scrollToOffset({
          offset: Math.max(0, scrollOffsetYRef.current + deltaY),
          animated: true,
        });
      },
    };
    viewportRef.current = handle;
    return () => {
      if (viewportRef.current === handle) {
        viewportRef.current = null;
      }
    };
  }, [agentId, bottomAnchorController, markNativeViewportSettling, viewportRef]);

  const handleScrollToIndexFailed = useStableEvent(
    (info: { index: number; highestMeasuredFrameIndex: number; averageItemLength: number }) => {
      if (scrollToIndexRecoveryFrameRef.current !== null) {
        cancelAnimationFrame(scrollToIndexRecoveryFrameRef.current);
      }
      const estimatedOffset = info.averageItemLength * info.index;
      flatListRef.current?.scrollToOffset({ offset: estimatedOffset, animated: false });
      scrollToIndexRecoveryFrameRef.current = requestAnimationFrame(() => {
        scrollToIndexRecoveryFrameRef.current = null;
        tryScrollToIndex(flatListRef, info.index, true);
      });
    },
  );

  useEffect(() => {
    return () => {
      if (scrollToIndexRecoveryFrameRef.current !== null) {
        cancelAnimationFrame(scrollToIndexRecoveryFrameRef.current);
        scrollToIndexRecoveryFrameRef.current = null;
      }
    };
  }, []);

  const handleScroll = useStableEvent((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const previousOffsetY = scrollOffsetYRef.current;
    scrollOffsetYRef.current = contentOffset.y;
    streamViewportMetricsRef.current = {
      contentHeight: Math.max(0, contentSize.height),
      viewportWidth: Math.max(0, layoutMeasurement.width),
      viewportHeight: Math.max(0, layoutMeasurement.height),
      containerKey: "native-virtualized",
      offsetY: contentOffset.y,
      viewportMeasuredForKey: "native-virtualized",
      contentMeasuredForKey: "native-virtualized",
    };

    const nearBottom = isNearBottomForStreamRenderStrategy({
      strategy,
      offsetY: contentOffset.y,
      threshold: 32,
      contentHeight: streamViewportMetricsRef.current.contentHeight,
      viewportHeight: streamViewportMetricsRef.current.viewportHeight,
    });
    onNearBottomChange(nearBottom);

    const distanceFromOldestEdge =
      streamViewportMetricsRef.current.contentHeight -
      streamViewportMetricsRef.current.viewportHeight -
      contentOffset.y;
    if (
      historyStartReadyRef.current &&
      hasOlderHistory &&
      distanceFromOldestEdge <= HISTORY_START_THRESHOLD_PX
    ) {
      onNearHistoryStart();
    }

    if (programmaticScrollEventBudgetRef.current > 0 && contentOffset.y <= 8) {
      programmaticScrollEventBudgetRef.current -= 1;
    } else {
      programmaticScrollEventBudgetRef.current = 0;
      bottomAnchorController.handleScrollNearBottomChange({
        nextIsNearBottom: nearBottom,
        scrollDelta: contentOffset.y - previousOffsetY,
      });
    }
  });

  const handleListLayout = useStableEvent((event: LayoutChangeEvent) => {
    const previousViewportWidth = streamViewportMetricsRef.current.viewportWidth;
    const previousViewportHeight = streamViewportMetricsRef.current.viewportHeight;
    const viewportWidth = Math.max(0, event.nativeEvent.layout.width);
    const viewportHeight = Math.max(0, event.nativeEvent.layout.height);
    const viewportChanged =
      (previousViewportWidth > 0 && previousViewportWidth !== viewportWidth) ||
      (previousViewportHeight > 0 && previousViewportHeight !== viewportHeight);
    streamViewportMetricsRef.current = {
      ...streamViewportMetricsRef.current,
      containerKey: "native-virtualized",
      viewportWidth,
      viewportHeight,
      viewportMeasuredForKey: "native-virtualized",
    };
    if (viewportChanged) {
      markNativeViewportSettling();
    }
    bottomAnchorController.handleViewportMetricsChange({
      previousViewportWidth,
      viewportWidth,
      previousViewportHeight,
      viewportHeight,
    });
  });

  const handleContentSizeChange = useStableEvent((_width: number, height: number) => {
    const previousContentHeight = streamViewportMetricsRef.current.contentHeight;
    const nextContentHeight = Math.max(0, height);
    streamViewportMetricsRef.current = {
      ...streamViewportMetricsRef.current,
      containerKey: "native-virtualized",
      contentHeight: nextContentHeight,
      contentMeasuredForKey: "native-virtualized",
    };
    bottomAnchorController.handleContentSizeChange({
      previousContentHeight,
      contentHeight: nextContentHeight,
    });
  });

  const renderItem = useStableEvent(
    ({ item, index }: ListRenderItemInfo<StreamItem>): ReactElement | null => {
      const rendered = renderHistoryMountedRow(item, index, historyItems);
      return (rendered ?? null) as ReactElement | null;
    },
  );

  const liveHeaderContent = useMemo(() => {
    // Stable render events read the latest expansion state; this revision makes
    // the memo invoke them again when that state changes.
    void liveHeadRowRevision;
    const liveHeadRows = segments.liveHead.map((item, index) => (
      <Fragment key={item.id}>{renderLiveHeadRow(item, index, segments.liveHead)}</Fragment>
    ));
    const liveAuxiliary = renderLiveAuxiliary();
    if (
      liveHeadRows.length === 0 &&
      !liveAuxiliary &&
      !boundary.hasMountedHistory &&
      !boundary.hasVirtualizedHistory
    ) {
      return (listEmptyComponent ?? null) as ReactElement | null;
    }
    return (
      <Fragment>
        {liveHeadRows}
        {liveAuxiliary}
      </Fragment>
    );
  }, [
    boundary,
    listEmptyComponent,
    liveHeadRowRevision,
    renderLiveAuxiliary,
    renderLiveHeadRow,
    segments.liveHead,
  ]);

  const historyFooterContent = useMemo(() => {
    if (!isLoadingOlderHistory) {
      return null;
    }
    return (
      <View testID="load-older-history-spinner">
        <ActivityIndicator size="small" />
      </View>
    );
  }, [isLoadingOlderHistory]);

  // RN's FlatList strictMode keeps its internal renderItem wrapper stable when
  // data or the live header changes, preserving the row identities above.
  return (
    <FlatList
      ref={flatListRef}
      data={historyRows}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      strictMode
      testID="agent-chat-scroll"
      nativeID="agent-chat-scroll-native-virtualized"
      ListHeaderComponent={liveHeaderContent ?? undefined}
      ListFooterComponent={historyFooterContent ?? undefined}
      contentContainerStyle={baseListContentContainerStyle}
      style={listStyle}
      onLayout={handleListLayout}
      onScroll={handleScroll}
      scrollEventThrottle={16}
      onContentSizeChange={handleContentSizeChange}
      onScrollToIndexFailed={handleScrollToIndexFailed}
      maintainVisibleContentPosition={DEFAULT_MAINTAIN_VISIBLE_CONTENT_POSITION}
      initialNumToRender={40}
      maxToRenderPerBatch={40}
      updateCellsBatchingPeriod={0}
      windowSize={21}
      removeClippedSubviews={false}
      scrollEnabled={scrollEnabled}
      showsVerticalScrollIndicator
      inverted
    />
  );
}

export function createNativeStreamStrategy(): StreamStrategy {
  const strategy = createStreamStrategy({
    render: (renderInput) => <NativeStreamViewport {...renderInput} strategy={strategy} />,
    orderTailReverse: true,
    orderHeadReverse: true,
    assistantTurnTraversalStep: 1,
    edgeSlot: "header",
    historyLiveBoundaryEdge: "first",
    liveHeadHistoryBoundaryEdge: "last",
    frameChildOrder: "footer-then-content",
    flatListInverted: true,
    overlayScrollbarInverted: true,
    maintainVisibleContentPosition: DEFAULT_MAINTAIN_VISIBLE_CONTENT_POSITION,
    bottomAnchorTransportBehavior: {
      verificationDelayFrames: 2,
      verificationRetryMode: "recheck",
    },
    disableParentScrollOnInlineDetailsExpansion: false,
    anchorBottomOnContentSizeChange: false,
    animateManualScrollToBottom: true,
    useVirtualizedList: true,
    isNearBottom: (input) => input.offsetY <= input.threshold,
    getBottomOffset: () => 0,
  });
  return strategy;
}
