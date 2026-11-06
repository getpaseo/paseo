import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollView,
  type ScrollViewProps,
  type ViewStyle,
} from "react-native";
import {
  LegendList,
  type LegendListRef,
  type LegendListRenderItemProps,
  useSyncLayout,
} from "@legendapp/list/react-native";
import { withUnistyles } from "react-native-unistyles";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { StreamItem } from "@/types/stream";
import type { Theme } from "@/styles/theme";
import { useStableEvent } from "@/hooks/use-stable-event";
import { shouldAnimateNativeScrollToBottom } from "./native-scroll-animation";
import { useRevisedHistoryRows } from "./history-row-revision";
import { useBottomAnchorController } from "./bottom-anchor-controller";
import { useScrollKeyboardDismiss } from "./scroll-keyboard-dismiss/use-scroll-keyboard-dismiss";
import { createNativeDisclosureHold } from "./native-disclosure-hold";
import { EndPinnedScrollView } from "./native-end-pin";
import { createNewRowEstimates } from "./new-row-estimates";
import type { StreamRenderInput, StreamStrategy, StreamViewportHandle } from "./strategy";
import { createStreamStrategy, isNearBottomForStreamRenderStrategy } from "./strategy";
import {
  abandonHistoryStartPaginationRequest,
  createHistoryStartPaginationState,
  evaluateHistoryStartPagination,
  isHistoryStartLoadingOperation,
  rearmHistoryStartPagination,
  settleHistoryStartPagination,
  type HistoryStartPaginationInput,
  type HistoryStartPaginationTransition,
} from "./history-start-pagination";
import { useStreamTopOverlayInset } from "./top-overlay";
import {
  createHistoryStartSettleScheduler,
  type HistoryStartSettleScheduler,
} from "./history-start-settle-scheduler";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const historyStartSlotStyle: ViewStyle = {
  alignItems: "center",
  justifyContent: "center",
  height: 32,
  flexShrink: 0,
};
const HISTORY_START_SETTLE_FRAMES = 2;
// Rendered distance on each side of the viewport. Smaller values blank the viewport while a fling
// crosses rows that were never measured (docs/agent-stream-disclosure.md).
const NATIVE_STREAM_DRAW_DISTANCE = 2000;
// Following resumes after a disclosure or a user scroll only from the end, so resuming never moves
// the rows the user is looking at. Web resumes within the same distance (strategy-web.tsx).
const AT_END_OFFSET_PX = 1;
// A disclosure settles after this many frames without an item size change.
const DISCLOSURE_QUIET_FRAMES = 2;
const BOTTOM_ANCHOR_TRANSPORT_BEHAVIOR = Object.freeze({
  verificationDelayFrames: 2,
  verificationRetryMode: "recheck" as const,
});

type RowLayoutSyncRegistry = Map<string, () => void>;

// A disclosure toggle changes a row from the row's own state, so LegendList's container does not
// re-render and would learn the new height from onLayout a task later, a frame after the change
// painted. The row's measurement trigger, called next to the toggle, batches the measurement and
// the corrected positions into the toggle's own commit.
function RowLayoutSync(props: {
  rowId: string;
  registry: RowLayoutSyncRegistry;
  children: ReactNode;
}) {
  const { rowId, registry } = props;
  const syncLayout = useSyncLayout();
  useLayoutEffect(() => {
    registry.set(rowId, syncLayout);
    return () => {
      if (registry.get(rowId) === syncLayout) {
        registry.delete(rowId);
      }
    };
  }, [registry, rowId, syncLayout]);
  return props.children;
}

function distanceFromEnd(input: {
  offsetY: number;
  contentHeight: number;
  viewportHeight: number;
}): number {
  return Math.max(0, input.contentHeight - input.viewportHeight - input.offsetY);
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
    olderHistoryProgressKey,
    scrollEnabled,
    listStyle,
    baseListContentContainerStyle,
    strategy,
  } = props;
  const { renderHistoryMountedRow, renderLiveHeadRow, renderLiveAuxiliary } = renderers;
  const listRef = useRef<LegendListRef>(null);
  // LegendList places the rows once, behind a hidden reveal, when the list mounts.
  const [isListPlaced, setIsListPlaced] = useState(false);
  const isListPlacedRef = useRef(isListPlaced);
  isListPlacedRef.current = isListPlaced;
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
  const isUserScrollActiveRef = useRef(false);
  const scrollKeyboardDismiss = useScrollKeyboardDismiss();
  const userScrollEndFrameIdRef = useRef<number | null>(null);
  const isReleasedAtEndRef = useRef(false);
  const programmaticScrollEventBudgetRef = useRef(0);
  const historyStartReadyRef = useRef(false);
  const [historyStartPaginationState, setHistoryStartPaginationState] = useState(
    createHistoryStartPaginationState,
  );
  const historyStartPaginationStateRef = useRef(historyStartPaginationState);
  const historyStartSettleSchedulerRef = useRef<HistoryStartSettleScheduler | null>(null);

  const historyItems = useMemo(() => {
    if (segments.historyVirtualized.length === 0) {
      return segments.historyMounted;
    }
    return [...segments.historyVirtualized, ...segments.historyMounted];
  }, [segments.historyMounted, segments.historyVirtualized]);
  const historyRows = useRevisedHistoryRows(historyItems, historyRowRevision);
  // Live rows are the tail of the list, so a row that finishes keeps its id, container and measured
  // size when it moves into history. A fresh identity per live-head change re-renders every live
  // row, which is how they pick up neighbour and expansion changes (`liveHeadRowRevision`).
  const liveRows = useMemo(() => {
    void liveHeadRowRevision;
    return segments.liveHead.map((item) => ({ ...item }));
  }, [segments.liveHead, liveHeadRowRevision]);
  const liveRowIds = useMemo(() => new Set(liveRows.map((item) => item.id)), [liveRows]);
  const [newRowEstimates] = useState(() => createNewRowEstimates<StreamItem>());
  const rows = useMemo(() => {
    const nextRows = [...historyRows, ...liveRows];
    newRowEstimates.noteRows(nextRows);
    return nextRows;
  }, [newRowEstimates, historyRows, liveRows]);
  const getEstimatedItemSize = useStableEvent((item: StreamItem) => newRowEstimates.estimate(item));
  const getHistoryStartPaginationInput = useStableEvent((): HistoryStartPaginationInput => {
    const metrics = streamViewportMetricsRef.current;
    const hasMeasuredViewport =
      metrics.viewportMeasuredForKey === metrics.containerKey &&
      metrics.contentMeasuredForKey === metrics.containerKey;
    return {
      distanceFromHistoryStart: metrics.offsetY,
      hasOlderHistory,
      isLoadingOlderHistory,
      isReady: historyStartReadyRef.current && hasMeasuredViewport,
      progressKey: olderHistoryProgressKey,
    };
  });
  const applyHistoryStartPaginationTransition = useStableEvent(
    (transition: HistoryStartPaginationTransition) => {
      const previousState = historyStartPaginationStateRef.current;
      historyStartPaginationStateRef.current = transition.state;
      if (transition.state !== previousState) {
        setHistoryStartPaginationState(transition.state);
      }
      if (transition.shouldLoad) {
        const requestedProgressKey = olderHistoryProgressKey;
        if (requestedProgressKey === null) {
          return;
        }
        void (async () => {
          const started = await onNearHistoryStart();
          if (started === true) {
            return;
          }
          applyHistoryStartPaginationTransition({
            state: abandonHistoryStartPaginationRequest(
              historyStartPaginationStateRef.current,
              requestedProgressKey,
            ),
            shouldLoad: false,
          });
        })();
      }
    },
  );
  const evaluateHistoryStart = useStableEvent(() => {
    const transition = evaluateHistoryStartPagination(
      historyStartPaginationStateRef.current,
      getHistoryStartPaginationInput(),
    );
    applyHistoryStartPaginationTransition(transition);
  });
  const scheduleHistoryStartSettle = useStableEvent(() => {
    let scheduler = historyStartSettleSchedulerRef.current;
    if (!scheduler) {
      scheduler = createHistoryStartSettleScheduler({
        settleFrames: HISTORY_START_SETTLE_FRAMES,
        requestFrame: requestAnimationFrame,
        cancelFrame: cancelAnimationFrame,
        isSettling: () => historyStartPaginationStateRef.current.status === "settling",
        isLoading: () => getHistoryStartPaginationInput().isLoadingOlderHistory,
        onSettle: () => {
          const transition = settleHistoryStartPagination(
            historyStartPaginationStateRef.current,
            getHistoryStartPaginationInput(),
          );
          applyHistoryStartPaginationTransition(transition);
        },
      });
      historyStartSettleSchedulerRef.current = scheduler;
    }
    scheduler.schedule();
  });

  const clearPendingUserScrollEnd = useCallback(() => {
    if (userScrollEndFrameIdRef.current !== null) {
      cancelAnimationFrame(userScrollEndFrameIdRef.current);
      userScrollEndFrameIdRef.current = null;
    }
  }, []);

  const getBottomAnchorTransportBehavior = useCallback(() => BOTTOM_ANCHOR_TRANSPORT_BEHAVIOR, []);

  const scrollToBottom = useCallback(
    (animated: boolean) => {
      programmaticScrollEventBudgetRef.current = 3;
      const metrics = streamViewportMetricsRef.current;
      // The native scroll view finds its end from the content it has mounted, and the end pin holds
      // it from there. LegendList's own scrollToEnd keeps re-aiming at the end its JS sizes predict
      // until it lands, which runs ahead of the mount and scrolls the end out of view.
      const list = listRef.current;
      list?.cancelScroll();
      // The scroll component is `EndPinnedScrollView`, a ScrollView.
      (list?.getNativeScrollRef() as ScrollView | undefined)?.scrollToEnd({
        animated:
          animated &&
          shouldAnimateNativeScrollToBottom({
            distanceFromEnd: distanceFromEnd(metrics),
            viewportHeight: metrics.viewportHeight,
            drawDistance: NATIVE_STREAM_DRAW_DISTANCE,
          }),
      });
      const endOffsetY = Math.max(0, metrics.contentHeight - metrics.viewportHeight);
      scrollOffsetYRef.current = endOffsetY;
      streamViewportMetricsRef.current = { ...metrics, offsetY: endOffsetY };
      onNearBottomChange(true);
    },
    [onNearBottomChange],
  );

  const bottomAnchorController = useBottomAnchorController({
    agentId,
    routeRequest: routeBottomAnchorRequest,
    isAuthoritativeHistoryReady,
    renderStrategy: "legend-stream",
    getTransportBehavior: getBottomAnchorTransportBehavior,
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

  const [rowLayoutSyncRegistry] = useState<RowLayoutSyncRegistry>(() => new Map());
  const isAtEnd = useStableEvent(
    () => distanceFromEnd(streamViewportMetricsRef.current) <= AT_END_OFFSET_PX,
  );
  const releaseDisclosure = useStableEvent(() => {
    bottomAnchorController.releaseDisclosure({ isAtEnd: isAtEnd() });
  });
  const [disclosureHold] = useState(() =>
    createNativeDisclosureHold({
      quietFrames: DISCLOSURE_QUIET_FRAMES,
      requestFrame: requestAnimationFrame,
      cancelFrame: cancelAnimationFrame,
      onRelease: releaseDisclosure,
    }),
  );
  useEffect(() => () => disclosureHold.cancel(), [disclosureHold]);
  // The hold detaches the controller in the same event as `apply`, so the toggle's commit already
  // has end following off and LegendList anchoring on the held row. The row's measurement trigger
  // makes that same commit carry the row's new height.
  const holdRow = useStableEvent((rowId: string, apply: () => void) => {
    disclosureHold.hold(rowId);
    bottomAnchorController.holdForDisclosure();
    apply();
    rowLayoutSyncRegistry.get(rowId)?.();
  });
  const handleItemSizeChanged = useStableEvent(
    (info: { size: number; previous: number; itemKey: string; itemData: StreamItem }) => {
      newRowEstimates.noteMeasured(info.itemData, info.size);
      disclosureHold.noteItemSizeChanged();
    },
  );
  const shouldRestorePosition = useStableEvent((item: StreamItem) => {
    const heldRowId = disclosureHold.heldRowId();
    return heldRowId === null || item.id === heldRowId;
  });
  // One owner keeps the scroll offset at any moment:
  // - Before the list has placed its rows for the agent: LegendList's initial scroll to the end. It
  //   keeps the rows hidden until they are measured and in place, so neither the pin nor the
  //   controller acts; the content does not count as measured yet (`handleContentSizeChange`).
  // - Following the end: the end pin. Rows added, rows resized and footer changes never scroll from
  //   JS; the pin holds the end in the frame the change mounts. The controller scrolls only for a
  //   viewport resize (the composer growing or shrinking), which the pin cannot see, and for an
  //   explicit jump, and both go to the native end (`scrollToBottom`). The keyboard does not resize
  //   the viewport: it translates the list with the composer. LegendList's end keeping stays off: it
  //   scrolls to the end its JS sizes predict, which runs ahead of the native mount, so it lands
  //   short of the real end and the controller reads that as the user scrolling away.
  // - A disclosure hold: the held row. The hold detaches the controller, which removes the pin, and
  //   LegendList keeps only the held row in place.
  // - A user scroll: the finger. The controller detaches for the gesture, so streamed lines grow below
  //   the rows the user is dragging, and resumes following if the gesture ends at the end.
  // - Detached: the visible rows. LegendList keeps the first visible row in place, so history loading
  //   above or rows growing below leave what the user is reading where it is.
  const isFollowingEnd = bottomAnchorController.mode === "sticky-bottom";
  const pinsEnd = isFollowingEnd && isListPlaced;
  const maintainVisibleContentPosition = useMemo(
    () => (isFollowingEnd ? false : { data: true, size: true, shouldRestorePosition }),
    [isFollowingEnd, shouldRestorePosition],
  );
  // A new identity re-renders LegendList's scroll component, which is how the pin follows the mode.
  const renderScrollComponent = useCallback(
    (scrollProps: ScrollViewProps) => <EndPinnedScrollView {...scrollProps} pinEnd={pinsEnd} />,
    [pinsEnd],
  );
  const topOverlayInset = useStreamTopOverlayInset();
  // No keyboard inset: one committed after the keyboard settles moves every row when the end pin is
  // not holding the offset (docs/agent-stream-disclosure.md).
  const listContentContainerStyle = useMemo(
    () => [baseListContentContainerStyle, { paddingTop: topOverlayInset }],
    [baseListContentContainerStyle, topOverlayInset],
  );

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      historyStartReadyRef.current = true;
      evaluateHistoryStart();
    });
    return () => {
      cancelAnimationFrame(frame);
      clearPendingUserScrollEnd();
      historyStartSettleSchedulerRef.current?.cancel();
      historyStartSettleSchedulerRef.current = null;
    };
  }, [clearPendingUserScrollEnd, evaluateHistoryStart]);

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
      },
      holdRow,
    };
    viewportRef.current = handle;
    return () => {
      if (viewportRef.current === handle) {
        viewportRef.current = null;
      }
    };
  }, [agentId, bottomAnchorController, holdRow, viewportRef]);

  // The scroll-to-bottom button shows whenever following would not resume on its own. A detached
  // list resumes only from the end, so the button shows anywhere short of it. While following, the
  // offset can trail content growth for a frame, so the controller's wider threshold keeps the
  // button from flashing.
  const publishNearBottom = useStableEvent(() => {
    const metrics = streamViewportMetricsRef.current;
    onNearBottomChange(
      bottomAnchorController.mode === "detached"
        ? distanceFromEnd(metrics) <= AT_END_OFFSET_PX
        : isNearBottomForStreamRenderStrategy({
            strategy,
            offsetY: metrics.offsetY,
            threshold: 32,
            contentHeight: metrics.contentHeight,
            viewportHeight: metrics.viewportHeight,
          }),
    );
  });

  // Following starts and stops without a scroll, for example when a disclosure hold begins short of
  // the end, and the button follows it.
  useEffect(() => {
    publishNearBottom();
  }, [isFollowingEnd, publishNearBottom]);

  const isScrollEventNearBottom = useStableEvent(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      return isNearBottomForStreamRenderStrategy({
        strategy,
        offsetY: contentOffset.y,
        threshold: 32,
        contentHeight: contentSize.height,
        viewportHeight: layoutMeasurement.height,
      });
    },
  );

  const isScrollEventAtEnd = useStableEvent((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    return (
      distanceFromEnd({
        offsetY: contentOffset.y,
        contentHeight: contentSize.height,
        viewportHeight: layoutMeasurement.height,
      }) <= AT_END_OFFSET_PX
    );
  });

  const handleScroll = useStableEvent((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const previousOffsetY = scrollOffsetYRef.current;
    scrollOffsetYRef.current = contentOffset.y;
    scrollKeyboardDismiss.onScroll(event);

    streamViewportMetricsRef.current = {
      contentHeight: Math.max(0, contentSize.height),
      viewportWidth: Math.max(0, layoutMeasurement.width),
      viewportHeight: Math.max(0, layoutMeasurement.height),
      containerKey: "native-virtualized",
      offsetY: contentOffset.y,
      viewportMeasuredForKey: "native-virtualized",
      contentMeasuredForKey: "native-virtualized",
    };

    const nearBottom = isScrollEventNearBottom(event);
    publishNearBottom();

    evaluateHistoryStart();

    if (
      !isUserScrollActiveRef.current &&
      programmaticScrollEventBudgetRef.current > 0 &&
      distanceFromEnd({
        offsetY: contentOffset.y,
        contentHeight: contentSize.height,
        viewportHeight: layoutMeasurement.height,
      }) <= 8
    ) {
      programmaticScrollEventBudgetRef.current -= 1;
    } else {
      programmaticScrollEventBudgetRef.current = 0;
      bottomAnchorController.handleScrollNearBottomChange({
        nextIsNearBottom: nearBottom,
        scrollDelta: contentOffset.y - previousOffsetY,
      });
    }
  });

  const handleScrollBeginDrag = useStableEvent((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    clearPendingUserScrollEnd();
    isUserScrollActiveRef.current = true;
    scrollKeyboardDismiss.onScrollBeginDrag(event);
    // The gesture takes the viewport from a disclosure hold. Size changes from a streaming row can
    // keep the hold's quiet frames from ever passing, and a held row that scrolls away would leave
    // no row LegendList may anchor a history page on. The gesture's end decides following.
    disclosureHold.cancel();
    bottomAnchorController.beginUserScroll();
    const rearmed = rearmHistoryStartPagination(historyStartPaginationStateRef.current);
    if (rearmed !== historyStartPaginationStateRef.current) {
      historyStartPaginationStateRef.current = rearmed;
      setHistoryStartPaginationState(rearmed);
      evaluateHistoryStart();
    }
  });

  // A gesture ends at the end when the finger lifts at or past it, or when its momentum stops there.
  // A release past the end bounces back to it on iOS, and lines that land during the bounce scroll
  // in as they do while following. Momentum stopping short of the end, or output that arrived below
  // the viewport before the decision, leaves the list detached.
  // Drag end is deferred a frame so momentum can take ownership.
  const handleScrollEndDrag = useStableEvent((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollKeyboardDismiss.onScrollEndDrag(event);
    isReleasedAtEndRef.current = isScrollEventAtEnd(event);

    clearPendingUserScrollEnd();
    userScrollEndFrameIdRef.current = requestAnimationFrame(() => {
      userScrollEndFrameIdRef.current = null;
      isUserScrollActiveRef.current = false;
      bottomAnchorController.endUserScroll({
        isAtEnd: isReleasedAtEndRef.current || isAtEnd(),
      });
    });
  });

  const handleMomentumScrollBegin = useStableEvent(() => {
    clearPendingUserScrollEnd();
  });

  const handleMomentumScrollEnd = useStableEvent(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      // Android can emit momentum-end after a programmatic anchor correction.
      // Only momentum that still owns the user gesture may settle scroll intent.
      if (!isUserScrollActiveRef.current) {
        return;
      }
      clearPendingUserScrollEnd();
      isUserScrollActiveRef.current = false;
      bottomAnchorController.endUserScroll({
        isAtEnd: isReleasedAtEndRef.current || isScrollEventAtEnd(event),
      });
    },
  );

  const handleListLayout = useStableEvent((event: LayoutChangeEvent) => {
    const previousViewportWidth = streamViewportMetricsRef.current.viewportWidth;
    const previousViewportHeight = streamViewportMetricsRef.current.viewportHeight;
    const viewportWidth = Math.max(0, event.nativeEvent.layout.width);
    const viewportHeight = Math.max(0, event.nativeEvent.layout.height);
    streamViewportMetricsRef.current = {
      ...streamViewportMetricsRef.current,
      containerKey: "native-virtualized",
      viewportWidth,
      viewportHeight,
      viewportMeasuredForKey: "native-virtualized",
    };
    bottomAnchorController.handleViewportMetricsChange({
      previousViewportWidth,
      viewportWidth,
      previousViewportHeight,
      viewportHeight,
    });
    evaluateHistoryStart();
  });

  const handleContentSizeChange = useStableEvent((_width: number, height: number) => {
    const nextContentHeight = Math.max(0, height);
    streamViewportMetricsRef.current = {
      ...streamViewportMetricsRef.current,
      containerKey: "native-virtualized",
      contentHeight: nextContentHeight,
      contentMeasuredForKey: isListPlacedRef.current ? "native-virtualized" : null,
    };
    bottomAnchorController.handleContentSizeChange();
    // Content growing below a detached viewport moves the end away without a scroll event.
    if (
      bottomAnchorController.mode === "detached" &&
      streamViewportMetricsRef.current.viewportHeight > 0
    ) {
      publishNearBottom();
    }
    evaluateHistoryStart();
    if (historyStartPaginationStateRef.current.status === "settling") {
      scheduleHistoryStartSettle();
    }
  });

  const handleListPlaced = useStableEvent(() => {
    isListPlacedRef.current = true;
    setIsListPlaced(true);
    streamViewportMetricsRef.current = {
      ...streamViewportMetricsRef.current,
      contentMeasuredForKey: "native-virtualized",
    };
    bottomAnchorController.handleContentSizeChange();
  });

  useEffect(() => {
    evaluateHistoryStart();
    if (historyStartPaginationStateRef.current.status === "settling") {
      scheduleHistoryStartSettle();
    }
  }, [
    evaluateHistoryStart,
    hasOlderHistory,
    isLoadingOlderHistory,
    olderHistoryProgressKey,
    scheduleHistoryStartSettle,
  ]);

  // LegendList re-renders a mounted row only when its item or `extraData` changes, not when
  // renderItem does. Item identity carries content and display changes (`useRevisedHistoryRows`);
  // `extraData` carries the history renderer, whose identity changes with the history layout (a
  // reply gaining its completed footer when the next prompt arrives) and keeps its row's item.
  // StreamRow's memo limits that pass to the rows whose layout item changed.
  const renderItem = useStableEvent(
    ({ item, index }: LegendListRenderItemProps<StreamItem>): ReactElement => (
      <RowLayoutSync rowId={item.id} registry={rowLayoutSyncRegistry}>
        {liveRowIds.has(item.id)
          ? renderLiveHeadRow(item, index - historyRows.length, segments.liveHead)
          : renderHistoryMountedRow(item, index, historyItems)}
      </RowLayoutSync>
    ),
  );

  const liveAuxiliaryContent = useMemo(() => {
    const liveAuxiliary = renderLiveAuxiliary();
    if (
      liveRows.length === 0 &&
      !liveAuxiliary &&
      !boundary.hasMountedHistory &&
      !boundary.hasVirtualizedHistory
    ) {
      return (listEmptyComponent ?? null) as ReactElement | null;
    }
    return <View>{liveAuxiliary}</View>;
  }, [boundary, listEmptyComponent, liveRows.length, renderLiveAuxiliary]);

  const historyStartContent = useMemo(() => {
    const isLoadingOperation = isHistoryStartLoadingOperation(historyStartPaginationState);
    return (
      <View style={historyStartSlotStyle} testID="older-history-slot">
        {isLoadingOperation ? (
          <View testID="load-older-history-spinner">
            <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
          </View>
        ) : null}
      </View>
    );
  }, [historyStartPaginationState]);

  return (
    <LegendList<StreamItem>
      ref={listRef}
      data={rows}
      renderItem={renderItem}
      extraData={renderHistoryMountedRow}
      keyExtractor={keyExtractor}
      testID="agent-chat-scroll"
      nativeID="agent-chat-scroll-native-virtualized"
      ListHeaderComponent={historyStartContent}
      ListFooterComponent={liveAuxiliaryContent ?? undefined}
      contentContainerStyle={listContentContainerStyle}
      automaticallyAdjustContentInsets={false}
      automaticallyAdjustsScrollIndicatorInsets={false}
      contentInsetAdjustmentBehavior="never"
      style={listStyle}
      onLayout={handleListLayout}
      onScroll={handleScroll}
      onScrollBeginDrag={handleScrollBeginDrag}
      onScrollEndDrag={handleScrollEndDrag}
      onMomentumScrollBegin={handleMomentumScrollBegin}
      onMomentumScrollEnd={handleMomentumScrollEnd}
      scrollEventThrottle={16}
      onContentSizeChange={handleContentSizeChange}
      onItemSizeChanged={handleItemSizeChanged}
      onReady={handleListPlaced}
      maintainVisibleContentPosition={maintainVisibleContentPosition}
      renderScrollComponent={renderScrollComponent}
      recycleItems={false}
      alignItemsAtEnd
      initialScrollAtEnd
      drawDistance={NATIVE_STREAM_DRAW_DISTANCE}
      getEstimatedItemSize={getEstimatedItemSize}
      scrollEnabled={scrollEnabled}
      showsVerticalScrollIndicator
    />
  );
}

export function createNativeStreamStrategy(): StreamStrategy {
  const strategy = createStreamStrategy({
    render: (renderInput) => <NativeStreamViewport {...renderInput} strategy={strategy} />,
    orderTailReverse: false,
    orderHeadReverse: false,
    assistantTurnTraversalStep: -1,
    edgeSlot: "footer",
    historyLiveBoundaryEdge: "last",
    liveHeadHistoryBoundaryEdge: "first",
    frameChildOrder: "content-then-footer",
    bottomAnchorTransportBehavior: BOTTOM_ANCHOR_TRANSPORT_BEHAVIOR,
    disableParentScrollOnInlineDetailsExpansion: false,
    anchorBottomOnContentSizeChange: false,
    animateManualScrollToBottom: true,
    useVirtualizedList: true,
    isNearBottom: (input) => distanceFromEnd(input) <= input.threshold,
    getBottomOffset: (metrics) => Math.max(0, metrics.contentHeight - metrics.viewportHeight),
  });
  return strategy;
}
