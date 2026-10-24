import {
  createContext,
  Fragment,
  type ReactElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  FlatList,
  Platform,
  View,
  type CellRendererProps,
  type LayoutChangeEvent,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewStyle,
} from "react-native";
import { withUnistyles } from "react-native-unistyles";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { StreamItem } from "@/types/stream";
import type { Theme } from "@/styles/theme";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useKeyboardStreamInset } from "@/keyboard/shift";
import { shouldAnimateNativeScrollToBottom } from "./native-scroll-animation";
import { useRevisedHistoryRows } from "./history-row-revision";
import {
  useBottomAnchorController,
  type BottomAnchorLocalRequest,
} from "./bottom-anchor-controller";
import { useScrollKeyboardDismiss } from "./scroll-keyboard-dismiss/use-scroll-keyboard-dismiss";
import type { StreamRenderInput, StreamStrategy, StreamViewportHandle } from "./strategy";
import {
  createStreamStrategy,
  isNearBottomForStreamRenderStrategy,
  resolveBottomAnchorTransportBehavior,
} from "./strategy";
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
import { getStreamItemMessageId } from "./presentation";
import {
  createNativePromptJumpSession,
  NATIVE_PROMPT_JUMP_APPROACH_BUDGET,
  resolveMeasuredWindowRevealPosition,
  stepInvertedPromptJump,
} from "./prompt-jump-native";
import { PROMPT_JUMP_TOP_INSET_PX } from "./prompt-jump-settle";
import { resolveInvertedReadingRow, type CellFrame } from "./reading-anchor";
import {
  createHistoryStartSettleScheduler,
  type HistoryStartSettleScheduler,
} from "./history-start-settle-scheduler";

const DEFAULT_MAINTAIN_VISIBLE_CONTENT_POSITION = Object.freeze({
  minIndexForVisible: 0,
  autoscrollToTopThreshold: 0,
});

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
const NATIVE_STREAM_WINDOW_SIZE = 10;

const PROMPT_JUMP_TICK_MS = 50;
// A far jump needs a larger batch to mount the unmeasured tail. Ordinary
// reading keeps the bounded native Markdown batches from the default viewport.
const PROMPT_JUMP_MAX_TO_RENDER_PER_BATCH = 48;
const PROMPT_JUMP_BATCH_PERIOD_MS = 16;

interface ScrollToIndexAtTopInput {
  index: number;
  animated: boolean;
}

function keyExtractor(item: { id: string }): string {
  return item.id;
}

type CellFrameListener = (cellKey: string, frame: CellFrame | null) => void;

const CellFrameListenerContext = createContext<CellFrameListener | null>(null);

// A cell's frame is in content coordinates, which FlatList keeps private. The reading
// position needs it to find the row under the floating header, which viewability ignores.
function StreamCell({
  cellKey,
  index: _index,
  item: _item,
  onLayout,
  children,
  ...viewProps
}: CellRendererProps<StreamItem>) {
  const onFrame = useContext(CellFrameListenerContext);
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onLayout?.(event);
      const { y, height } = event.nativeEvent.layout;
      onFrame?.(cellKey, { y, height });
    },
    [cellKey, onFrame, onLayout],
  );
  useEffect(() => () => onFrame?.(cellKey, null), [cellKey, onFrame]);
  return (
    <View {...viewProps} onLayout={handleLayout}>
      {children}
    </View>
  );
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
    onReadingPositionChange,
    onUserScrollStart,
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
  const isUserScrollActiveRef = useRef(false);
  const scrollKeyboardDismiss = useScrollKeyboardDismiss();
  const streamKeyboardInset = useKeyboardStreamInset();
  const userScrollEndFrameIdRef = useRef<number | null>(null);
  const programmaticScrollEventBudgetRef = useRef(0);
  const isNativeViewportSettlingRef = useRef(false);
  const nativeViewportSettlingFrameIdRef = useRef<number | null>(null);
  const historyStartReadyRef = useRef(false);
  const [historyStartPaginationState, setHistoryStartPaginationState] = useState(
    createHistoryStartPaginationState,
  );
  const historyStartPaginationStateRef = useRef(historyStartPaginationState);
  const historyStartSettleSchedulerRef = useRef<HistoryStartSettleScheduler | null>(null);
  const [cellFrames] = useState(() => new Map<string, CellFrame>());
  const liveHeadHeightRef = useRef(0);
  const readingPositionFrameIdRef = useRef<number | null>(null);
  const [promptJumpBatch, setPromptJumpBatch] = useState(false);

  const historyItems = useMemo(() => {
    if (segments.historyVirtualized.length === 0) {
      return segments.historyMounted;
    }
    return [...segments.historyVirtualized, ...segments.historyMounted];
  }, [segments.historyMounted, segments.historyVirtualized]);
  const historyRows = useRevisedHistoryRows(historyItems, historyRowRevision);
  const getHistoryStartPaginationInput = useStableEvent((): HistoryStartPaginationInput => {
    const metrics = streamViewportMetricsRef.current;
    const hasMeasuredViewport =
      metrics.viewportMeasuredForKey === metrics.containerKey &&
      metrics.contentMeasuredForKey === metrics.containerKey;
    return {
      distanceFromHistoryStart: metrics.contentHeight - metrics.viewportHeight - metrics.offsetY,
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

  const clearNativeViewportSettling = useCallback(() => {
    if (nativeViewportSettlingFrameIdRef.current !== null) {
      cancelAnimationFrame(nativeViewportSettlingFrameIdRef.current);
      nativeViewportSettlingFrameIdRef.current = null;
    }
  }, []);

  const clearPendingUserScrollEnd = useCallback(() => {
    if (userScrollEndFrameIdRef.current !== null) {
      cancelAnimationFrame(userScrollEndFrameIdRef.current);
      userScrollEndFrameIdRef.current = null;
    }
  }, []);

  const markNativeViewportSettling = useCallback(() => {
    clearNativeViewportSettling();
    isNativeViewportSettlingRef.current = true;
    let remainingFrames = 4;
    const tick = () => {
      if (remainingFrames <= 0) {
        nativeViewportSettlingFrameIdRef.current = null;
        isNativeViewportSettlingRef.current = false;
        return;
      }
      remainingFrames -= 1;
      nativeViewportSettlingFrameIdRef.current = requestAnimationFrame(tick);
    };
    nativeViewportSettlingFrameIdRef.current = requestAnimationFrame(tick);
  }, [clearNativeViewportSettling]);

  const getBottomAnchorTransportBehavior = useCallback(
    () =>
      resolveBottomAnchorTransportBehavior({
        strategy,
        isViewportSettling: isNativeViewportSettlingRef.current,
      }),
    [strategy],
  );

  const scrollToBottom = useCallback(
    (animated: boolean) => {
      programmaticScrollEventBudgetRef.current = 3;
      flatListRef.current?.scrollToOffset({
        offset: 0,
        animated:
          animated &&
          shouldAnimateNativeScrollToBottom({
            offsetY: scrollOffsetYRef.current,
            viewportHeight: streamViewportMetricsRef.current.viewportHeight,
            windowSize: NATIVE_STREAM_WINDOW_SIZE,
          }),
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
  // Android's maintainVisibleContentPosition ignores the list inversion transform and
  // fights the controller's offset-zero correction while the live header grows.
  const maintainVisibleContentPosition =
    Platform.OS === "android" && bottomAnchorController.mode === "sticky-bottom"
      ? undefined
      : DEFAULT_MAINTAIN_VISIBLE_CONTENT_POSITION;
  const topOverlayInset = useStreamTopOverlayInset();
  // The list is inverted, so its content's bottom padding is the visual top.
  const listContentContainerStyle = useMemo(
    () => [
      baseListContentContainerStyle,
      {
        paddingBottom: streamKeyboardInset.contentContainerPaddingBottom + topOverlayInset,
      },
    ],
    [
      baseListContentContainerStyle,
      streamKeyboardInset.contentContainerPaddingBottom,
      topOverlayInset,
    ],
  );
  const listInsetProps = useMemo(
    () =>
      streamKeyboardInset.contentInset
        ? {
            automaticallyAdjustContentInsets: false,
            automaticallyAdjustsScrollIndicatorInsets: false,
            contentInsetAdjustmentBehavior: "never" as const,
            contentInset: streamKeyboardInset.contentInset,
            scrollIndicatorInsets: streamKeyboardInset.contentInset,
          }
        : {},
    [streamKeyboardInset.contentInset],
  );

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
    isUserScrollActiveRef.current = false;
    clearPendingUserScrollEnd();
    clearNativeViewportSettling();
    isNativeViewportSettlingRef.current = false;
    historyStartReadyRef.current = false;
    const initialHistoryStartState = createHistoryStartPaginationState();
    historyStartPaginationStateRef.current = initialHistoryStartState;
    setHistoryStartPaginationState(initialHistoryStartState);
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
  }, [agentId, clearNativeViewportSettling, clearPendingUserScrollEnd, evaluateHistoryStart]);

  useEffect(() => () => clearNativeViewportSettling(), [clearNativeViewportSettling]);

  useEffect(() => {
    bottomAnchorController.prepareForStickyContentChange();
  }, [bottomAnchorController, historyRows, segments.liveHead]);

  const reportReadingPosition = useStableEvent(() => {
    if (!onReadingPositionChange) {
      return;
    }
    const metrics = streamViewportMetricsRef.current;
    const readingRow = resolveInvertedReadingRow({
      frames: cellFrames,
      offsetY: metrics.offsetY,
      viewportHeight: metrics.viewportHeight,
      topInset: topOverlayInset,
    });
    if (readingRow?.kind === "row") {
      onReadingPositionChange(readingRow.id);
      return;
    }
    if (readingRow?.kind === "live-head") {
      // The live head is newest first, so its last row is the one at the visual top.
      onReadingPositionChange(segments.liveHead.at(-1)?.id ?? historyRows[0]?.id ?? null);
      return;
    }
    onReadingPositionChange(null);
  });

  const scheduleReadingPosition = useStableEvent(() => {
    if (readingPositionFrameIdRef.current !== null) {
      return;
    }
    readingPositionFrameIdRef.current = requestAnimationFrame(() => {
      readingPositionFrameIdRef.current = null;
      reportReadingPosition();
    });
  });

  const handleCellFrame = useStableEvent((cellKey: string, frame: CellFrame | null) => {
    if (frame) {
      cellFrames.set(cellKey, frame);
    } else {
      cellFrames.delete(cellKey);
    }
    scheduleReadingPosition();
  });

  const requestBottomAnchor = useStableEvent((request: BottomAnchorLocalRequest) => {
    onUserScrollStart?.();
    bottomAnchorController.requestLocalAnchor(request);
  });
  const [promptJump] = useState(() =>
    createNativePromptJumpSession({
      schedule: (callback) => {
        const timer = setTimeout(callback, PROMPT_JUMP_TICK_MS);
        return () => clearTimeout(timer);
      },
      setBatchActive: setPromptJumpBatch,
      requestBottomAnchor,
    }),
  );
  const cancelPromptJump = promptJump.cancel;
  const endPromptJump = promptJump.end;

  useEffect(
    () => () => {
      if (readingPositionFrameIdRef.current !== null) {
        cancelAnimationFrame(readingPositionFrameIdRef.current);
      }
      cancelPromptJump();
    },
    [cancelPromptJump],
  );

  useEffect(() => {
    endPromptJump();
  }, [agentId, endPromptJump]);

  const handleLiveHeadLayout = useStableEvent((event: LayoutChangeEvent) => {
    liveHeadHeightRef.current = event.nativeEvent.layout.height;
  });

  // First approach, and the landing scroll when FlatList already measured the row.
  // viewPosition 1 plus a negative viewOffset puts the row's far edge just under the header.
  const scrollToIndexAtTop = useStableEvent(({ index, animated }: ScrollToIndexAtTopInput) => {
    flatListRef.current?.scrollToIndex({
      index,
      animated,
      viewPosition: 1,
      viewOffset: -(topOverlayInset + PROMPT_JUMP_TOP_INSET_PX),
    });
  });

  // A plugin row can be taller than the render overscan. Pinning that row's start
  // never mounts the following row, so the measured index sticks. A short row still
  // pins its start, which fills the viewport with the next rows.
  const revealBeyondMeasuredIndex = useStableEvent((index: number) => {
    const row = historyRows[index];
    const frame = row ? cellFrames.get(row.id) : null;
    flatListRef.current?.scrollToIndex({
      index,
      animated: false,
      viewPosition: resolveMeasuredWindowRevealPosition({
        frameHeight: frame?.height ?? 0,
        viewportHeight: streamViewportMetricsRef.current.viewportHeight,
        windowSize: NATIVE_STREAM_WINDOW_SIZE,
      }),
    });
  });

  const schedulePromptJumpTick = useStableEvent(() => {
    promptJump.schedule(correctPromptJump);
  });

  const correctPromptJump = useStableEvent(() => {
    const jump = promptJump.getCurrent();
    if (jump === null) return;
    if (isUserScrollActiveRef.current) {
      endPromptJump();
      return;
    }
    const index = historyRows.findIndex((item) => getStreamItemMessageId(item) === jump.messageId);
    const row = index >= 0 ? historyRows[index] : undefined;
    const frame = row ? (cellFrames.get(row.id) ?? null) : null;
    const metrics = streamViewportMetricsRef.current;
    const step = stepInvertedPromptJump({
      frame,
      offsetY: metrics.offsetY,
      viewportHeight: metrics.viewportHeight,
      contentHeight: metrics.contentHeight,
      topInset: topOverlayInset,
      sampled: jump.sampled,
      stable: jump.stable,
    });
    if (step.kind === "settled" || step.kind === "stopped") {
      endPromptJump();
      return;
    }
    if (step.kind === "correct") {
      jump.sampled = step.sampled;
      jump.stable = step.stable;
      flatListRef.current?.scrollToOffset({ offset: step.offset, animated: false });
      schedulePromptJumpTick();
      return;
    }
    if (step.kind === "hold") {
      jump.sampled = step.sampled;
      jump.stable = step.stable;
      schedulePromptJumpTick();
      return;
    }
    jump.approachSteps += 1;
    if (jump.approachSteps > NATIVE_PROMPT_JUMP_APPROACH_BUDGET) {
      endPromptJump();
      return;
    }
    if (index >= 0) {
      scrollToIndexAtTop({ index, animated: false });
    }
    schedulePromptJumpTick();
  });

  const beginPromptJump = useStableEvent((messageId: string) => {
    const index = historyRows.findIndex((item) => getStreamItemMessageId(item) === messageId);
    // The list reads the larger batch on its next render-window update.
    promptJump.begin(messageId);
    if (index >= 0) {
      scrollToIndexAtTop({ index, animated: false });
    }
    schedulePromptJumpTick();
  });

  const scrollToMessage = useStableEvent((messageId: string) => {
    const index = historyRows.findIndex((item) => getStreamItemMessageId(item) === messageId);
    const isInLiveHead = segments.liveHead.some(
      (item) => getStreamItemMessageId(item) === messageId,
    );
    if (index < 0 && !isInLiveHead) {
      return;
    }
    bottomAnchorController.detachByUser();
    onNearBottomChange(false);
    if (index >= 0) {
      beginPromptJump(messageId);
      return;
    }
    endPromptJump();
    // Live rows live in the list header, at the start of the content.
    const metrics = streamViewportMetricsRef.current;
    flatListRef.current?.scrollToOffset({
      offset: Math.max(
        0,
        liveHeadHeightRef.current -
          metrics.viewportHeight +
          topOverlayInset +
          PROMPT_JUMP_TOP_INSET_PX,
      ),
      animated: true,
    });
  });

  // scrollToIndex bails without moving when the index is past the measured window, and it
  // never retries a row it only estimated. The settle tick owns the retry. This handler
  // only brings the next unmeasured rows on screen.
  const handleScrollToIndexFailed = useStableEvent(
    (info: { index: number; highestMeasuredFrameIndex: number }) => {
      const jump = promptJump.getCurrent();
      if (jump === null) return;
      const targetIndex = historyRows.findIndex(
        (item) => getStreamItemMessageId(item) === jump.messageId,
      );
      if (targetIndex < 0 || info.index !== targetIndex) return;
      if (info.highestMeasuredFrameIndex < 0) return;
      revealBeyondMeasuredIndex(info.highestMeasuredFrameIndex);
    },
  );

  useEffect(() => {
    const handle: StreamViewportHandle = {
      scrollToMessage,
      cancelScrollToMessage: endPromptJump,
      scrollToBottom: (reason = "jump-to-bottom") => {
        promptJump.requestBottomAnchor({
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
  }, [
    agentId,
    bottomAnchorController,
    endPromptJump,
    promptJump,
    markNativeViewportSettling,
    scrollToMessage,
    viewportRef,
  ]);

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
    onNearBottomChange(nearBottom);
    reportReadingPosition();

    evaluateHistoryStart();

    if (
      !isUserScrollActiveRef.current &&
      programmaticScrollEventBudgetRef.current > 0 &&
      contentOffset.y <= 8
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
    // Non-animated scrollTo does not emit begin-drag, so this is the reader's finger.
    endPromptJump();
    onUserScrollStart?.();
    isUserScrollActiveRef.current = true;
    scrollKeyboardDismiss.onScrollBeginDrag(event);
    bottomAnchorController.beginUserScroll();
    const rearmed = rearmHistoryStartPagination(historyStartPaginationStateRef.current);
    if (rearmed !== historyStartPaginationStateRef.current) {
      historyStartPaginationStateRef.current = rearmed;
      setHistoryStartPaginationState(rearmed);
      evaluateHistoryStart();
    }
  });

  // Defer drag end so momentum can take ownership, but capture the terminal
  // gesture position now because layout may move the viewport in the meantime.
  const handleScrollEndDrag = useStableEvent((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const isNearBottom = isScrollEventNearBottom(event);
    scrollKeyboardDismiss.onScrollEndDrag(event);

    clearPendingUserScrollEnd();
    userScrollEndFrameIdRef.current = requestAnimationFrame(() => {
      userScrollEndFrameIdRef.current = null;
      isUserScrollActiveRef.current = false;
      bottomAnchorController.endUserScroll({ isNearBottom });
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
      const isNearBottom = isScrollEventNearBottom(event);
      clearPendingUserScrollEnd();
      isUserScrollActiveRef.current = false;
      bottomAnchorController.endUserScroll({ isNearBottom });
    },
  );

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
    scheduleReadingPosition();
    evaluateHistoryStart();
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
    evaluateHistoryStart();
    if (historyStartPaginationStateRef.current.status === "settling") {
      scheduleHistoryStartSettle();
    }
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
      <View collapsable={false} onLayout={handleLiveHeadLayout}>
        {liveHeadRows}
        {liveAuxiliary}
      </View>
    );
  }, [
    boundary,
    handleLiveHeadLayout,
    listEmptyComponent,
    liveHeadRowRevision,
    renderLiveAuxiliary,
    renderLiveHeadRow,
    segments.liveHead,
  ]);

  const historyFooterContent = useMemo(() => {
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

  // RN's FlatList strictMode keeps its internal renderItem wrapper stable when
  // data or the live header changes, preserving the row identities above.
  return (
    <CellFrameListenerContext.Provider value={handleCellFrame}>
      <FlatList
        {...listInsetProps}
        ref={flatListRef}
        data={historyRows}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        CellRendererComponent={StreamCell}
        strictMode
        testID="agent-chat-scroll"
        nativeID="agent-chat-scroll-native-virtualized"
        ListHeaderComponent={liveHeaderContent ?? undefined}
        ListFooterComponent={historyFooterContent ?? undefined}
        contentContainerStyle={listContentContainerStyle}
        style={listStyle}
        onLayout={handleListLayout}
        onScroll={handleScroll}
        onScrollBeginDrag={handleScrollBeginDrag}
        onScrollEndDrag={handleScrollEndDrag}
        onMomentumScrollBegin={handleMomentumScrollBegin}
        onMomentumScrollEnd={handleMomentumScrollEnd}
        scrollEventThrottle={16}
        onContentSizeChange={handleContentSizeChange}
        onScrollToIndexFailed={handleScrollToIndexFailed}
        maintainVisibleContentPosition={maintainVisibleContentPosition}
        // A history row can contain an entire long reply. Keep synchronous native
        // Markdown measurement bounded while FlatList fills the surrounding window.
        initialNumToRender={2}
        windowSize={NATIVE_STREAM_WINDOW_SIZE}
        // Both props are read on every render-window update, so the larger
        // batch applies only to the batches that run during a prompt jump.
        maxToRenderPerBatch={promptJumpBatch ? PROMPT_JUMP_MAX_TO_RENDER_PER_BATCH : 10}
        updateCellsBatchingPeriod={promptJumpBatch ? PROMPT_JUMP_BATCH_PERIOD_MS : undefined}
        removeClippedSubviews={false}
        scrollEnabled={scrollEnabled}
        showsVerticalScrollIndicator
        inverted
      />
    </CellFrameListenerContext.Provider>
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
