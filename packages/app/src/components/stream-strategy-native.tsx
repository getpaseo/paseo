import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Keyboard,
  type LayoutChangeEvent,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import type { StreamItem } from "@/types/stream";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useBottomAnchorController } from "./use-bottom-anchor-controller";
import type { StreamRenderInput, StreamStrategy, StreamViewportHandle } from "./stream-strategy";
import {
  createStreamStrategy,
  isNearBottomForStreamRenderStrategy,
  resolveBottomAnchorTransportBehavior,
} from "./stream-strategy";

const DEFAULT_MAINTAIN_VISIBLE_CONTENT_POSITION = Object.freeze({
  minIndexForVisible: 0,
  autoscrollToTopThreshold: 0,
});

function NativeStreamViewport(props: StreamRenderInput & { strategy: StreamStrategy }) {
  const {
    agentId,
    segments,
    boundary,
    renderers,
    listEmptyComponent,
    viewportRef,
    routeBottomAnchorRequest,
    isAuthoritativeHistoryReady,
    onNearBottomChange,
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
  const [isNativeViewportSettling, setIsNativeViewportSettling] = useState(false);
  const nativeViewportSettlingFrameIdRef = useRef<number | null>(null);

  const historyRows = useMemo(() => {
    if (segments.historyVirtualized.length === 0) {
      return segments.historyMounted;
    }
    return [...segments.historyVirtualized, ...segments.historyMounted];
  }, [segments.historyMounted, segments.historyVirtualized]);

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
    };
    viewportRef.current = handle;
    return () => {
      if (viewportRef.current === handle) {
        viewportRef.current = null;
      }
    };
  }, [agentId, bottomAnchorController, markNativeViewportSettling, viewportRef]);

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

  const renderItem = useStableEvent(({ item, index }: ListRenderItemInfo<StreamItem>) => {
    const rendered = renderHistoryMountedRow(item, index, historyRows);
    return rendered ? <Fragment>{rendered}</Fragment> : null;
  });

  const liveHeaderContent = useMemo(() => {
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
      return listEmptyComponent ? <Fragment>{listEmptyComponent}</Fragment> : null;
    }
    return (
      <Fragment>
        {liveHeadRows}
        {liveAuxiliary}
      </Fragment>
    );
  }, [boundary, listEmptyComponent, renderLiveAuxiliary, renderLiveHeadRow, segments.liveHead]);

  return (
    <FlatList
      ref={flatListRef}
      data={historyRows}
      renderItem={renderItem}
      keyExtractor={(item) => item.id}
      testID="agent-chat-scroll"
      nativeID="agent-chat-scroll-native-virtualized"
      ListHeaderComponent={liveHeaderContent ?? undefined}
      contentContainerStyle={baseListContentContainerStyle}
      style={listStyle}
      onLayout={handleListLayout}
      onScroll={handleScroll}
      scrollEventThrottle={16}
      onContentSizeChange={handleContentSizeChange}
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
