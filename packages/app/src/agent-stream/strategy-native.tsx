import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
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
  type ViewProps,
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
import { Button } from "@/components/ui/button";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useTranslation } from "react-i18next";
import { getStreamItemMessageId, type StreamItem } from "@/types/stream";
import type { Theme } from "@/styles/theme";
import { useStableEvent } from "@/hooks/use-stable-event";
import { shouldAnimateNativeScrollToBottom } from "./native-scroll-animation";
import { useRevisedHistoryRows } from "./history-row-revision";
import {
  useBottomAnchorController,
  type BottomAnchorLocalRequest,
} from "./bottom-anchor-controller";
import { useScrollKeyboardDismiss } from "./scroll-keyboard-dismiss/use-scroll-keyboard-dismiss";
import {
  createNativeDisclosureHold,
  disclosureAnchor,
  createEndHoldDistance,
  type EndHoldDistance,
} from "./native-disclosure-hold";
import { EndPinnedScrollView } from "./native-end-pin";
import { createNewRowEstimates } from "./new-row-estimates";
import type {
  DisclosureTriggerEdge,
  StreamRenderInput,
  StreamStrategy,
  StreamViewportHandle,
} from "./strategy";
import { createStreamStrategy, isNearBottomForStreamRenderStrategy } from "./strategy";
import {
  isHistoryStartLoadingOperation,
  type HistoryStartPaginationInput,
} from "./history-start-pagination";
import { useHistoryStartPagination } from "./use-history-start-pagination";
import { nativeHistoryStartGeometry } from "./native-history-start-geometry";
import { useStreamTopOverlayInset } from "./top-overlay";
import {
  createNativePromptJumpSession,
  NATIVE_PROMPT_JUMP_APPROACH_BUDGET,
  stepNativePromptJump,
} from "./prompt-jump-native";
import { PROMPT_JUMP_TOP_INSET_PX } from "./prompt-jump-settle";
import { resolveNativeReadingRow, type CellFrame } from "./reading-anchor";
import {
  createHistoryStartSettleScheduler,
  type HistoryStartSettleScheduler,
} from "./history-start-settle-scheduler";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const HISTORY_START_SLOT_HEIGHT = 32;
const historyStartSlotStyle: ViewStyle = {
  alignItems: "center",
  justifyContent: "center",
  height: HISTORY_START_SLOT_HEIGHT,
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
const viewportStyle: ViewStyle = { flex: 1 };
const initialFillStyle: ViewStyle = {
  position: "absolute",
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  alignItems: "center",
  justifyContent: "center",
};

const PROMPT_JUMP_TICK_MS = 50;

interface ScrollToIndexAtTopInput {
  index: number;
  animated: boolean;
}

function keyExtractor(item: { id: string }): string {
  return item.id;
}

type CellFrameListener = (cellKey: string, frame: CellFrame | null) => void;

const CellFrameListenerContext = createContext<CellFrameListener | null>(null);

interface StreamCellProps extends ViewProps {
  cellKey: string;
  children: ReactNode;
}

// A cell's frame is in content coordinates, which the list keeps private. The reading
// position needs it to find the row under the floating header, which viewability ignores.
function StreamCell({ cellKey, onLayout, children, ...viewProps }: StreamCellProps) {
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
    isInitialHistoryLoading,
    revealInitialHistory,
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
  const isActive = useRetainedPanelActive();
  const { t } = useTranslation();
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
  const historyStartSettleSchedulerRef = useRef<HistoryStartSettleScheduler | null>(null);
  const [cellFrames] = useState(() => new Map<string, CellFrame>());
  const readingPositionFrameIdRef = useRef<number | null>(null);

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
      ...nativeHistoryStartGeometry({
        contentHeight: metrics.contentHeight,
        viewportHeight: metrics.viewportHeight,
        offsetY: metrics.offsetY,
        topOverlayInset,
      }),
      hasOlderHistory,
      isLoadingOlderHistory,
      isReady:
        isActive &&
        isAuthoritativeHistoryReady &&
        historyStartReadyRef.current &&
        hasMeasuredViewport,
      progressKey: olderHistoryProgressKey,
    };
  });
  const { state: historyStartPaginationState, controller: historyStartPagination } =
    useHistoryStartPagination({
      initiallyVisible: !isInitialHistoryLoading,
      read: getHistoryStartPaginationInput,
      load: async () => onNearHistoryStart(),
      scheduleSettle: () => scheduleHistoryStartSettle(),
    });
  const evaluateHistoryStart = useStableEvent(() => historyStartPagination.update());
  const disposeHistoryStart = useStableEvent(() => historyStartPagination.dispose());
  const isHistoryStartSettling = useStableEvent(
    () => historyStartPagination.state.status === "settling",
  );
  const finishInitialFill = useStableEvent(() => historyStartPagination.reveal());
  const retryHistoryStart = useStableEvent(() => historyStartPagination.rearm());
  const scheduleHistoryStartSettle = useStableEvent(() => {
    let scheduler = historyStartSettleSchedulerRef.current;
    if (!scheduler) {
      scheduler = createHistoryStartSettleScheduler({
        settleFrames: HISTORY_START_SETTLE_FRAMES,
        requestFrame: requestAnimationFrame,
        cancelFrame: cancelAnimationFrame,
        isSettling: () => isHistoryStartSettling(),
        isLoading: () => getHistoryStartPaginationInput().isLoadingOlderHistory,
        onSettle: () => historyStartPagination.settle(),
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
  // A hold on the content end mounts the end pin while detached (`holdRow`). The release reads the
  // tracked distance instead of the offset: the content size reaches JS before the pin's scroll does.
  const [endHold, setEndHold] = useState<{ rowId: string; distance: EndHoldDistance } | null>(null);
  const releaseDisclosure = useStableEvent(() => {
    setEndHold(null);
    bottomAnchorController.releaseDisclosure({
      isAtEnd: endHold ? endHold.distance.current() <= AT_END_OFFSET_PX : isAtEnd(),
    });
  });
  const [disclosureHold] = useState(() =>
    createNativeDisclosureHold({
      quietFrames: DISCLOSURE_QUIET_FRAMES,
      requestFrame: requestAnimationFrame,
      cancelFrame: cancelAnimationFrame,
      onRelease: releaseDisclosure,
    }),
  );
  const cancelDisclosureHold = useStableEvent(() => {
    disclosureHold.cancel();
    setEndHold(null);
  });
  useEffect(() => () => cancelDisclosureHold(), [cancelDisclosureHold]);
  // The hold detaches the controller in the same event as `apply`, so the toggle's commit already
  // has end following off and LegendList anchoring on the held row, or on the row below it for a
  // trigger on the row's bottom edge. The row's measurement trigger makes that same commit carry
  // the row's new height. While following, a bottom trigger keeps following: the end pin holds the
  // content end, and with it the bottom of the row, in the frame the new height mounts.
  // The last row's bottom is the content end, which LegendList cannot anchor. The end pin can, from
  // any offset, but only once it is mounted: a pin that mounts with the new height anchors nothing.
  // So the toggle lands a frame after the pin's commit, whose mount runs before the frame's timers.
  const latestDisclosureAnchor = useStableEvent(
    (rowId: string, triggerEdge: DisclosureTriggerEdge) =>
      disclosureAnchor(rows, rowId, triggerEdge),
  );
  const holdRow = useStableEvent(
    (rowId: string, apply: () => void, triggerEdge: DisclosureTriggerEdge) => {
      const applyAndMeasure = () => {
        apply();
        rowLayoutSyncRegistry.get(rowId)?.();
      };
      if (triggerEdge === "bottom" && bottomAnchorController.mode === "sticky-bottom") {
        applyAndMeasure();
        return;
      }
      const anchor = disclosureAnchor(rows, rowId, triggerEdge);
      bottomAnchorController.holdForDisclosure();
      if (anchor.kind === "row" || !isListPlacedRef.current) {
        setEndHold(null);
        disclosureHold.hold(anchor);
        applyAndMeasure();
        return;
      }
      setEndHold({
        rowId,
        distance: createEndHoldDistance(distanceFromEnd(streamViewportMetricsRef.current)),
      });
      disclosureHold.holdNextFrame(
        () => latestDisclosureAnchor(rowId, triggerEdge),
        (latestAnchor) => {
          if (latestAnchor.kind === "row") setEndHold(null);
          applyAndMeasure();
        },
      );
    },
  );
  const handleItemSizeChanged = useStableEvent(
    (info: { size: number; previous: number; itemKey: string; itemData: StreamItem }) => {
      newRowEstimates.noteMeasured(info.itemData, info.size);
      disclosureHold.noteItemSizeChanged();
      scheduleReadingPosition();
    },
  );
  const shouldRestorePosition = useStableEvent((item: StreamItem) => {
    const anchorRowId = disclosureHold.anchorRowId();
    return anchorRowId === null || item.id === anchorRowId;
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
  //   LegendList keeps only the held row in place, or the row below it when the trigger sits on the
  //   held row's bottom edge. A bottom-edge hold while following leaves the end pin in charge, and
  //   one on the last row mounts the pin for the hold: the row's bottom is the content end.
  // - A user scroll: the finger. The controller detaches for the gesture, so streamed lines grow below
  //   the rows the user is dragging, and resumes following if the gesture ends at the end.
  // - Detached: the visible rows. LegendList keeps the first visible row in place, so history loading
  //   above or rows growing below leave what the user is reading where it is.
  const isFollowingEnd = bottomAnchorController.mode === "sticky-bottom";
  // An end hold pins the end only while its row's bottom is the end. A reply landing below the row
  // drops the pin in the commit that mounts the reply, so the reply grows below the held row.
  const isEndHeld =
    endHold !== null && disclosureAnchor(rows, endHold.rowId, "bottom").kind === "end";
  const isEndPinned = isFollowingEnd || isEndHeld;
  const pinsEnd = isEndPinned && isListPlaced;
  const maintainVisibleContentPosition = useMemo(
    () => (isEndPinned ? false : { data: true, size: true, shouldRestorePosition }),
    [isEndPinned, shouldRestorePosition],
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
      disposeHistoryStart();
      historyStartSettleSchedulerRef.current?.cancel();
      historyStartSettleSchedulerRef.current = null;
    };
  }, [clearPendingUserScrollEnd, disposeHistoryStart, evaluateHistoryStart]);

  const getCellFrame = useStableEvent((cellKey: string): CellFrame | null => {
    const frame = cellFrames.get(cellKey);
    if (!frame) return null;
    const position = listRef.current?.getState().positionByKey(cellKey);
    const y =
      position === undefined ? frame.y : topOverlayInset + HISTORY_START_SLOT_HEIGHT + position;
    return { y, height: frame.height };
  });

  const reportReadingPosition = useStableEvent(() => {
    if (!onReadingPositionChange) {
      return;
    }
    const metrics = streamViewportMetricsRef.current;
    const frames = new Map<string, CellFrame>();
    for (const key of cellFrames.keys()) {
      const frame = getCellFrame(key);
      if (frame) frames.set(key, frame);
    }
    const readingRow = resolveNativeReadingRow({
      frames,
      offsetY: metrics.offsetY,
      viewportHeight: metrics.viewportHeight,
      topInset: topOverlayInset,
    });
    if (readingRow?.kind === "row") {
      onReadingPositionChange(readingRow.id);
      return;
    }
    if (readingRow?.kind === "live-head") {
      // The live head runs oldest-first, so its last row is the newest row at the end.
      onReadingPositionChange(segments.liveHead.at(-1)?.id ?? historyRows.at(-1)?.id ?? null);
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
      setBatchActive: () => undefined,
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

  // First approach, and the landing scroll when the list already measured the row.
  // viewPosition 0 plus a positive viewOffset puts the row's top edge just under the header.
  const scrollToIndexAtTop = useStableEvent(({ index, animated }: ScrollToIndexAtTopInput) => {
    listRef.current?.scrollToIndex({
      index,
      animated,
      viewPosition: 0,
      viewOffset: topOverlayInset + PROMPT_JUMP_TOP_INSET_PX,
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
    const index = rows.findIndex((item) => getStreamItemMessageId(item) === jump.messageId);
    const row = index >= 0 ? rows[index] : undefined;
    const frame = row ? getCellFrame(row.id) : null;
    const metrics = streamViewportMetricsRef.current;
    const step = stepNativePromptJump({
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
      listRef.current?.scrollToOffset({ offset: step.offset, animated: false });
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
    const index = rows.findIndex((item) => getStreamItemMessageId(item) === messageId);
    // The list reads the larger batch on its next render-window update.
    promptJump.begin(messageId);
    if (index >= 0) {
      scrollToIndexAtTop({ index, animated: false });
    }
    schedulePromptJumpTick();
  });

  const scrollToMessage = useStableEvent((messageId: string) => {
    const index = rows.findIndex((item) => getStreamItemMessageId(item) === messageId);
    if (index < 0) {
      return;
    }
    bottomAnchorController.detachByUser();
    onNearBottomChange(false);
    beginPromptJump(messageId);
  });

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
      },
      holdRow,
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
    holdRow,
    promptJump,
    scrollToMessage,
    viewportRef,
  ]);

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
    reportReadingPosition();

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
    finishInitialFill();
    clearPendingUserScrollEnd();
    // Non-animated scrollTo does not emit begin-drag, so this is the reader's finger.
    endPromptJump();
    onUserScrollStart?.();
    isUserScrollActiveRef.current = true;
    scrollKeyboardDismiss.onScrollBeginDrag(event);
    // The gesture takes the viewport from a disclosure hold. Size changes from a streaming row can
    // keep the hold's quiet frames from ever passing, and a held row that scrolls away would leave
    // no row LegendList may anchor a history page on. The gesture's end decides following.
    cancelDisclosureHold();
    bottomAnchorController.beginUserScroll();
    historyStartPagination.rearm();
  });

  useEffect(() => {
    if (revealInitialHistory) finishInitialFill();
  }, [finishInitialFill, revealInitialHistory]);

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
    scheduleReadingPosition();
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
    endHold?.distance.noteContentSize(streamViewportMetricsRef.current);
    bottomAnchorController.handleContentSizeChange();
    // Content growing below a detached viewport moves the end away without a scroll event.
    if (
      bottomAnchorController.mode === "detached" &&
      streamViewportMetricsRef.current.viewportHeight > 0
    ) {
      publishNearBottom();
    }
    evaluateHistoryStart();
    if (isHistoryStartSettling()) {
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
    evaluateHistoryStart();
  });

  useEffect(() => {
    evaluateHistoryStart();
    if (isHistoryStartSettling()) {
      scheduleHistoryStartSettle();
    }
  }, [
    evaluateHistoryStart,
    hasOlderHistory,
    isActive,
    isAuthoritativeHistoryReady,
    isLoadingOlderHistory,
    olderHistoryProgressKey,
    scheduleHistoryStartSettle,
    isHistoryStartSettling,
  ]);

  // LegendList re-renders a mounted row only when its item or `extraData` changes, not when
  // renderItem does. Item identity carries content and display changes (`useRevisedHistoryRows`);
  // `extraData` carries the history renderer, whose identity changes with the history layout (a
  // reply gaining its completed footer when the next prompt arrives) and keeps its row's item.
  // StreamRow's memo limits that pass to the rows whose layout item changed.
  const renderItem = useStableEvent(
    ({ item, index }: LegendListRenderItemProps<StreamItem>): ReactElement => (
      <StreamCell cellKey={item.id}>
        <RowLayoutSync rowId={item.id} registry={rowLayoutSyncRegistry}>
          {liveRowIds.has(item.id)
            ? renderLiveHeadRow(item, index - historyRows.length, segments.liveHead)
            : renderHistoryMountedRow(item, index, historyItems)}
        </RowLayoutSync>
      </StreamCell>
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
        {isLoadingOperation && (
          <View testID="load-older-history-spinner">
            <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
          </View>
        )}
        {!isLoadingOperation &&
          historyStartPaginationState.status === "failed" &&
          hasOlderHistory && (
            <Button variant="ghost" size="sm" onPress={retryHistoryStart}>
              {t("paneFind.retry")}
            </Button>
          )}
      </View>
    );
  }, [historyStartPaginationState, hasOlderHistory, retryHistoryStart, t]);

  return (
    <CellFrameListenerContext.Provider value={handleCellFrame}>
      <View style={viewportStyle}>
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
          style={[listStyle, { opacity: historyStartPaginationState.visible ? 1 : 0 }]}
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
        {!historyStartPaginationState.visible ? (
          <View pointerEvents="none" testID="agent-initial-fill" style={initialFillStyle}>
            <ThemedLoadingSpinner size="large" uniProps={foregroundMutedColorMapping} />
          </View>
        ) : null}
      </View>
    </CellFrameListenerContext.Provider>
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
