import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import {
  Keyboard,
  type LayoutChangeEvent,
  PanResponder,
  type PanResponderGestureState,
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import type { ITheme } from "@xterm/xterm";
import type { TerminalState } from "@getpaseo/protocol/messages";
import {
  TerminalInputModeTracker,
  terminalInputModeStatesEqual,
  type TerminalInputModeState,
} from "@getpaseo/protocol/terminal-input-mode";
import type { TerminalOutputData } from "../terminal/runtime/terminal-emulator-runtime";
import type {
  TerminalLocalFileLinkSource,
  TerminalLocalFileLinkTarget,
} from "../terminal/local-links/terminal-local-link-provider";
import type { PendingTerminalModifiers } from "../utils/terminal-keys";
import type { TerminalRendererReadyChange } from "../utils/terminal-renderer-readiness";
import {
  createNativeHeadlessTerminal,
  type NativeHeadlessTerminal,
  type TerminalViewportState,
} from "../terminal/native-renderer/headless-terminal-state";
import {
  createNativeTerminalOutputDrain,
  type NativeTerminalOutputDrain,
} from "../terminal/native-renderer/headless-terminal-output-drain";
import { TerminalGridView } from "../terminal/native-renderer/terminal-grid-view.native";
import type { TerminalGridCellMetrics } from "../terminal/native-renderer/terminal-grid-metrics";
import {
  createNativeTerminalScreenModel,
  type TerminalScreenModel,
  type TerminalScreenState,
} from "../terminal/native-renderer/terminal-screen-model";
import {
  copyTerminalSelection,
  createTerminalSelectionModel,
  hitTestTerminalSelectionCell,
  type TerminalBufferCoordinate,
  type TerminalClipboardWriter,
  type TerminalSelectionModel,
  type TerminalSelectionRange,
  type TerminalSelectionViewport,
} from "../terminal/native-renderer/terminal-selection";
import {
  TERMINAL_GESTURE_LONG_PRESS_MS,
  TERMINAL_GESTURE_TAP_TOLERANCE_PX,
  classifyTerminalGestureIntent,
  resolveTerminalGestureReleaseAction,
  type TerminalGestureIntent,
} from "../terminal/native-renderer/terminal-selection-gesture";
import {
  forwardNativeTerminalKey,
  type NativeTerminalKey,
} from "../terminal/native-renderer/terminal-key-events";
import {
  TerminalInput,
  type TerminalInputHandle,
} from "../terminal/native-renderer/terminal-input.native";
import { encodeTerminalPaste } from "../terminal/runtime/terminal-paste";
import { renderTerminalSnapshotToAnsi } from "../terminal/runtime/terminal-snapshot";
import {
  createTerminalResizePolicy,
  updateTerminalResizePolicy,
  type TerminalResizeSource,
} from "../terminal/native-renderer/terminal-resize-policy";
import {
  resolveMeasuredNativeTerminalSize,
  type TerminalMeasuredLayout,
  type TerminalMeasuredSize,
} from "../terminal/native-renderer/terminal-size-measurement";

export interface TerminalEmulatorHandle {
  writeOutput: (data: TerminalOutputData) => void;
  restoreOutput: (data: TerminalOutputData) => void;
  renderSnapshot: (state: TerminalState | null) => void;
  paste: (text: string) => void;
  copySelection: (clipboard: TerminalClipboardWriter) => Promise<string>;
  clear: () => void;
  showKeyboard: () => void;
  blur: () => void;
}

interface TerminalEmulatorProps {
  dom?: unknown;
  ref: Ref<TerminalEmulatorHandle>;
  streamKey: string;
  testId?: string;
  xtermTheme?: ITheme;
  scrollbackLines: number;
  fontFamily?: string;
  fontSize?: number;
  keyboardInset?: number;
  swipeGesturesEnabled?: boolean;
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  initialSnapshot?: TerminalState | null;
  onInput?: (data: string) => Promise<void> | void;
  onFocus?: () => Promise<void> | void;
  onResize?: (input: {
    rows: number;
    cols: number;
    shouldClaim: boolean;
    forceClaim?: boolean;
  }) => Promise<void> | void;
  onTerminalKey?: (input: {
    key: string;
    ctrl: boolean;
    shift: boolean;
    alt: boolean;
    meta: boolean;
  }) => Promise<void> | void;
  onPendingModifiersConsumed?: () => Promise<void> | void;
  onInputModeChange?: (state: TerminalInputModeState) => Promise<void> | void;
  onSelectionChange?: (hasSelection: boolean) => void;
  onResolveLocalFileLink?: (
    source: TerminalLocalFileLinkSource,
  ) => Promise<TerminalLocalFileLinkTarget | null> | TerminalLocalFileLinkTarget | null;
  onOpenLocalFileLink?: (
    target: TerminalLocalFileLinkTarget,
    disposition: "main" | "side",
  ) => Promise<void> | void;
  onRendererReadyChange?: (change: TerminalRendererReadyChange) => void;
  pendingModifiers?: PendingTerminalModifiers;
  focusRequestToken?: number;
  resizeRequestToken?: number;
}

const MIN_NATIVE_TERMINAL_ROWS = 1;
const MIN_NATIVE_TERMINAL_COLS = 1;
const DEFAULT_XTERM_THEME: ITheme = {
  background: "#0b0b0b",
  foreground: "#e6e6e6",
  cursor: "#e6e6e6",
};
interface NativeTerminalPanState {
  lastDy: number;
  rowRemainder: number;
  didScroll: boolean;
  didNavigate: boolean;
  movedBeyondTapTolerance: boolean;
  intent: TerminalGestureIntent | null;
}

interface NativeTerminalSelectionPress {
  startX: number;
  startY: number;
  startedAt: number;
  status: "pressing" | "selecting";
}

function resolvePanResponderPoint(
  press: NativeTerminalSelectionPress,
  event: GestureResponderEvent,
  gesture: PanResponderGestureState,
): { x: number; y: number } {
  const eventDx = event.nativeEvent.locationX - press.startX;
  const eventDy = event.nativeEvent.locationY - press.startY;
  const dx = Math.abs(eventDx) > Math.abs(gesture.dx) ? eventDx : gesture.dx;
  const dy = Math.abs(eventDy) > Math.abs(gesture.dy) ? eventDy : gesture.dy;
  return {
    x: press.startX + dx,
    y: press.startY + dy,
  };
}

function initialNativeTerminalSize(snapshot: TerminalState | null): TerminalMeasuredSize {
  return {
    rows: snapshot?.rows ?? MIN_NATIVE_TERMINAL_ROWS,
    cols: snapshot?.cols ?? MIN_NATIVE_TERMINAL_COLS,
  };
}

function terminalViewportSnapshot(state: TerminalState): TerminalState {
  return {
    ...state,
    scrollback: [],
    scrollbackWrapped: undefined,
  };
}

function screenStateFromViewport(viewport: TerminalViewportState): TerminalScreenState {
  const visibleRows = viewport.grid.length;
  const currentViewport = {
    firstRow: viewport.firstRow,
    lastRow: Math.min(viewport.newestRow, viewport.firstRow + Math.max(1, visibleRows) - 1),
  };
  return {
    viewport,
    scroll: {
      mode: "following",
      firstRow: viewport.firstRow,
      visibleRows,
      oldestRow: viewport.oldestRow,
      newestRow: viewport.newestRow,
      currentViewport,
      bottomViewport: currentViewport,
    },
  };
}

function viewportStateFromSnapshot(state: TerminalState): TerminalViewportState {
  return {
    rows: state.grid.length,
    cols: state.cols,
    firstRow: 0,
    oldestRow: 0,
    newestRow: Math.max(0, state.grid.length - 1),
    grid: state.grid,
    cursor: state.cursor,
  };
}

function NativeTerminalEmulator({
  ref,
  streamKey,
  testId = "terminal-surface",
  xtermTheme = DEFAULT_XTERM_THEME,
  scrollbackLines,
  fontFamily,
  fontSize,
  keyboardInset = 0,
  initialSnapshot = null,
  onInput,
  onTerminalKey,
  onResize,
  onSwipeLeft,
  onSwipeRight,
  onInputModeChange,
  onSelectionChange,
  onRendererReadyChange,
  onFocus,
  focusRequestToken = 0,
  resizeRequestToken = 0,
}: TerminalEmulatorProps) {
  const terminalRef = useRef<NativeHeadlessTerminal | null>(null);
  const inputRef = useRef<TerminalInputHandle>(null);
  const terminalSizeRef = useRef<TerminalMeasuredSize>(initialNativeTerminalSize(initialSnapshot));
  const resizePolicyRef = useRef(
    createTerminalResizePolicy(initialNativeTerminalSize(initialSnapshot)),
  );
  const activeResizeClaimTokenRef = useRef(0);
  const layoutRef = useRef<TerminalMeasuredLayout | null>(null);
  const metricsRef = useRef<TerminalGridCellMetrics | null>(null);
  const hasNotifiedMeasuredSizeRef = useRef(false);
  const outputDrainRef = useRef<NativeTerminalOutputDrain | null>(null);
  const screenModelRef = useRef<TerminalScreenModel | null>(null);
  const selectionModelRef = useRef<TerminalSelectionModel>(createTerminalSelectionModel());
  const selectionLongPressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectionPressRef = useRef<NativeTerminalSelectionPress | null>(null);
  const latestResolvedScreenRef = useRef<TerminalScreenState | null>(null);
  const paintFrameRef = useRef<number | null>(null);
  const outputDecoderRef = useRef(new TextDecoder());
  const panStateRef = useRef<NativeTerminalPanState>({
    lastDy: 0,
    rowRemainder: 0,
    didScroll: false,
    didNavigate: false,
    movedBeyondTapTolerance: false,
    intent: null,
  });
  const inputModeTrackerRef = useRef(new TerminalInputModeTracker());
  const lastInputModeStateRef = useRef<TerminalInputModeState>({
    ...inputModeTrackerRef.current.getState(),
    applicationCursorKeys: false,
  });
  const [terminalScreen, setTerminalScreen] = useState<TerminalScreenState | null>(() => {
    return initialSnapshot
      ? screenStateFromViewport(viewportStateFromSnapshot(initialSnapshot))
      : null;
  });
  const [selectionRange, setSelectionRange] = useState<TerminalSelectionRange | null>(null);
  const selectionRangeRef = useRef<TerminalSelectionRange | null>(null);
  const terminalScreenRef = useRef<TerminalScreenState | null>(terminalScreen);
  const callbacksRef = useRef({
    onFocus,
    onInput,
    onTerminalKey,
    onInputModeChange,
    onSelectionChange,
    onRendererReadyChange,
    onResize,
    onSwipeLeft,
    onSwipeRight,
  });
  callbacksRef.current = {
    onFocus,
    onInput,
    onTerminalKey,
    onInputModeChange,
    onSelectionChange,
    onRendererReadyChange,
    onResize,
    onSwipeLeft,
    onSwipeRight,
  };

  const getInputModeState = useCallback((): TerminalInputModeState => {
    const trackedState = inputModeTrackerRef.current.getState();
    return {
      ...trackedState,
      applicationCursorKeys:
        terminalRef.current?.getInputModeState().applicationCursorKeys ?? false,
    };
  }, []);

  const emitInputModeChange = useCallback(() => {
    const state = getInputModeState();
    if (terminalInputModeStatesEqual(state, lastInputModeStateRef.current)) {
      return;
    }
    lastInputModeStateRef.current = state;
    callbacksRef.current.onInputModeChange?.(state);
  }, [getInputModeState]);

  const resetInputModeTracker = useCallback(() => {
    inputModeTrackerRef.current.reset();
    emitInputModeChange();
  }, [emitInputModeChange]);

  const commitTerminalScreen = useCallback((screen: TerminalScreenState) => {
    latestResolvedScreenRef.current = screen;
    terminalScreenRef.current = screen;
    setTerminalScreen(screen);
  }, []);

  const commitSelectionRange = useCallback((range: TerminalSelectionRange | null) => {
    selectionRangeRef.current = range;
    setSelectionRange((current) => {
      if (current === range) {
        return current;
      }
      return range;
    });
  }, []);

  useEffect(() => {
    callbacksRef.current.onSelectionChange?.(selectionRange !== null);
  }, [selectionRange]);

  const clearSelection = useCallback(() => {
    const snapshot = selectionModelRef.current.clear();
    commitSelectionRange(snapshot.range);
  }, [commitSelectionRange]);

  useEffect(() => {
    terminalScreenRef.current = terminalScreen;
  }, [terminalScreen]);

  const syncSelectionWithTerminal = useCallback(
    (terminal: NativeHeadlessTerminal) => {
      const snapshot = selectionModelRef.current.sync({ bounds: terminal.getBufferBounds() });
      commitSelectionRange(snapshot.range);
    },
    [commitSelectionRange],
  );

  const clearSelectionLongPressTimeout = useCallback(() => {
    if (selectionLongPressTimeoutRef.current === null) {
      return;
    }
    clearTimeout(selectionLongPressTimeoutRef.current);
    selectionLongPressTimeoutRef.current = null;
  }, []);

  const resolveVisibleRows = useCallback((terminal: NativeHeadlessTerminal): number => {
    return (
      resolveMeasuredNativeTerminalSize({
        layout: layoutRef.current,
        metrics: metricsRef.current,
      })?.rows ?? terminal.getBufferBounds().rows
    );
  }, []);

  const resolveTerminalScreen = useCallback(
    (terminal: NativeHeadlessTerminal): TerminalScreenState => {
      if (!screenModelRef.current) {
        screenModelRef.current = createNativeTerminalScreenModel({ terminal });
      }
      const screen = screenModelRef.current.sync({ visibleRows: resolveVisibleRows(terminal) });
      latestResolvedScreenRef.current = screen;
      return screen;
    },
    [resolveVisibleRows],
  );

  const paintTerminalScreen = useCallback(
    (terminal: NativeHeadlessTerminal): TerminalViewportState => {
      const screen = resolveTerminalScreen(terminal);
      commitTerminalScreen(screen);
      syncSelectionWithTerminal(terminal);
      return screen.viewport;
    },
    [commitTerminalScreen, resolveTerminalScreen, syncSelectionWithTerminal],
  );

  const schedulePaint = useCallback(() => {
    if (paintFrameRef.current !== null) {
      return;
    }
    paintFrameRef.current = requestAnimationFrame(() => {
      paintFrameRef.current = null;
      const terminal = terminalRef.current;
      if (!terminal) {
        return;
      }
      paintTerminalScreen(terminal);
    });
  }, [paintTerminalScreen]);

  const createOutputDrain = useCallback(
    (terminal: NativeHeadlessTerminal): NativeTerminalOutputDrain =>
      createNativeTerminalOutputDrain({
        write: async (chunk) => {
          await terminal.write(chunk);
          emitInputModeChange();
        },
        reset: () => {
          terminal.reset();
          emitInputModeChange();
        },
        getViewportState: () => {
          const screen = resolveTerminalScreen(terminal);
          syncSelectionWithTerminal(terminal);
          return screen.viewport;
        },
        onPaint: () => {
          const screen = latestResolvedScreenRef.current;
          if (screen) {
            commitTerminalScreen(screen);
          }
        },
        scheduleFrame: requestAnimationFrame,
        cancelFrame: cancelAnimationFrame,
      }),
    [commitTerminalScreen, emitInputModeChange, resolveTerminalScreen, syncSelectionWithTerminal],
  );

  const emitMeasuredSize = useCallback(
    (input: { source: TerminalResizeSource; claimToken?: number }) => {
      const nextSize = resolveMeasuredNativeTerminalSize({
        layout: layoutRef.current,
        metrics: metricsRef.current,
      });
      if (!nextSize) {
        if (input.source === "claim") {
          resizePolicyRef.current = updateTerminalResizePolicy(resizePolicyRef.current, {
            source: input.source,
            size: null,
            claimToken: input.claimToken,
          }).state;
        }
        return;
      }
      const policyResult = updateTerminalResizePolicy(resizePolicyRef.current, {
        source: input.source,
        size: nextSize,
        claimToken: input.claimToken,
      });
      resizePolicyRef.current = policyResult.state;
      if (
        !policyResult.measuredSizeChanged &&
        !policyResult.resizeClaim &&
        hasNotifiedMeasuredSizeRef.current
      ) {
        return;
      }

      hasNotifiedMeasuredSizeRef.current = true;
      terminalSizeRef.current = policyResult.measuredSize;
      if (policyResult.measuredSizeChanged) {
        terminalRef.current?.resize(policyResult.measuredSize);
        schedulePaint();
      }
      callbacksRef.current.onResize?.({
        rows: policyResult.measuredSize.rows,
        cols: policyResult.measuredSize.cols,
        shouldClaim: policyResult.resizeClaim !== null,
        forceClaim: policyResult.resizeClaim?.force,
      });
    },
    [schedulePaint],
  );

  const syncSnapshotToHeadless = useCallback((state: TerminalState) => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    const drain = outputDrainRef.current;
    drain?.clear();
    drain?.enqueueText(renderTerminalSnapshotToAnsi(terminalViewportSnapshot(state)));
  }, []);

  const resetTerminal = useCallback(
    (snapshot: TerminalState | null) => {
      outputDrainRef.current?.dispose();
      outputDrainRef.current = null;
      terminalRef.current?.dispose();
      screenModelRef.current = null;
      latestResolvedScreenRef.current = null;
      clearSelection();
      const measuredSize = resolveMeasuredNativeTerminalSize({
        layout: layoutRef.current,
        metrics: metricsRef.current,
      });
      const size =
        measuredSize ??
        (snapshot ? { rows: snapshot.rows, cols: snapshot.cols } : terminalSizeRef.current);
      terminalSizeRef.current = size;
      resizePolicyRef.current = createTerminalResizePolicy(size);
      outputDecoderRef.current.decode();
      const terminal = createNativeHeadlessTerminal({
        rows: size.rows,
        cols: size.cols,
        scrollbackLines,
      });
      terminalRef.current = terminal;
      screenModelRef.current = createNativeTerminalScreenModel({ terminal });
      outputDrainRef.current = createOutputDrain(terminal);
      const screen = snapshot
        ? screenStateFromViewport(viewportStateFromSnapshot(snapshot))
        : resolveTerminalScreen(terminal);
      commitTerminalScreen(screen);
      resetInputModeTracker();
      if (snapshot) {
        syncSnapshotToHeadless(snapshot);
      }
    },
    [
      commitTerminalScreen,
      createOutputDrain,
      resetInputModeTracker,
      resolveTerminalScreen,
      scrollbackLines,
      syncSnapshotToHeadless,
      clearSelection,
    ],
  );

  const enqueueOutputText = useCallback(
    (text: string) => {
      if (text.length === 0) {
        return;
      }
      const inputModeUpdate = inputModeTrackerRef.current.feed(text);
      if (inputModeUpdate.changed) {
        emitInputModeChange();
      }
      outputDrainRef.current?.enqueueText(text);
    },
    [emitInputModeChange],
  );

  const claimActiveTerminalSize = useCallback(() => {
    activeResizeClaimTokenRef.current += 1;
    emitMeasuredSize({ source: "claim", claimToken: activeResizeClaimTokenRef.current });
  }, [emitMeasuredSize]);

  useImperativeHandle(
    ref,
    (): TerminalEmulatorHandle => ({
      writeOutput: (data: TerminalOutputData) => {
        const text = outputDecoderRef.current.decode(data, { stream: true });
        enqueueOutputText(text);
      },
      restoreOutput: (data: TerminalOutputData) => {
        outputDecoderRef.current.decode();
        resetInputModeTracker();
        const text = outputDecoderRef.current.decode(data, { stream: false });
        outputDrainRef.current?.restoreText(text);
      },
      renderSnapshot: (state: TerminalState | null) => {
        outputDecoderRef.current.decode();
        if (state && terminalRef.current && terminalScreenRef.current?.scroll.mode === "scrolled") {
          return;
        }
        resetInputModeTracker();
        if (!state) {
          resetTerminal(null);
          return;
        }
        resetTerminal(state);
      },
      paste: (text: string) => {
        if (text.length === 0) {
          return;
        }
        claimActiveTerminalSize();
        callbacksRef.current.onInput?.(
          encodeTerminalPaste({
            text,
            bracketedPaste: terminalRef.current?.getInputModeState().bracketedPaste ?? false,
          }),
        );
      },
      copySelection: async (clipboard: TerminalClipboardWriter): Promise<string> => {
        const terminal = terminalRef.current;
        if (!terminal) {
          return "";
        }
        const selection = selectionModelRef.current.getSnapshot().range;
        const copied = await copyTerminalSelection({ terminal, selection, clipboard });
        if (copied.length > 0) {
          clearSelection();
        }
        return copied;
      },
      clear: () => {
        outputDecoderRef.current.decode();
        outputDrainRef.current?.clear();
        screenModelRef.current?.reset();
        clearSelection();
        resetInputModeTracker();
        terminalRef.current?.reset();
        schedulePaint();
      },
      showKeyboard: () => {
        inputRef.current?.showKeyboard();
        claimActiveTerminalSize();
      },
      blur: () => {
        inputRef.current?.blur();
        Keyboard.dismiss();
      },
    }),
    [
      enqueueOutputText,
      claimActiveTerminalSize,
      clearSelection,
      resetInputModeTracker,
      resetTerminal,
      schedulePaint,
    ],
  );

  useEffect(() => {
    hasNotifiedMeasuredSizeRef.current = false;
    resetTerminal(initialSnapshot);
    callbacksRef.current.onRendererReadyChange?.({ streamKey, isReady: true });
    return () => {
      callbacksRef.current.onRendererReadyChange?.({ streamKey, isReady: false });
      clearSelectionLongPressTimeout();
      selectionPressRef.current = null;
      if (paintFrameRef.current !== null) {
        cancelAnimationFrame(paintFrameRef.current);
        paintFrameRef.current = null;
      }
      outputDrainRef.current?.dispose();
      outputDrainRef.current = null;
      terminalRef.current?.dispose();
      terminalRef.current = null;
    };
  }, [clearSelectionLongPressTimeout, initialSnapshot, resetTerminal, streamKey]);

  useEffect(() => {
    if (focusRequestToken <= 0) return;
    inputRef.current?.focus();
  }, [focusRequestToken]);

  const handleTerminalFocus = useCallback(() => {
    callbacksRef.current.onFocus?.();
    claimActiveTerminalSize();
  }, [claimActiveTerminalSize]);

  const handleTerminalInput = useCallback(
    (data: string) => {
      claimActiveTerminalSize();
      callbacksRef.current.onInput?.(data);
    },
    [claimActiveTerminalSize],
  );

  const handleNativeTerminalKey = useCallback(
    (key: NativeTerminalKey) => {
      claimActiveTerminalSize();
      forwardNativeTerminalKey({ key, onTerminalKey: callbacksRef.current.onTerminalKey });
    },
    [claimActiveTerminalSize],
  );

  const focusTerminalFromTap = useCallback(() => {
    clearSelection();
    inputRef.current?.focus();
    claimActiveTerminalSize();
  }, [claimActiveTerminalSize, clearSelection]);

  useEffect(() => {
    if (resizeRequestToken <= 0) return;
    claimActiveTerminalSize();
  }, [claimActiveTerminalSize, resizeRequestToken]);

  useEffect(() => {
    emitMeasuredSize({ source: "measure" });
  }, [emitMeasuredSize, keyboardInset]);

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      layoutRef.current = {
        width: event.nativeEvent.layout.width,
        height: event.nativeEvent.layout.height,
      };
      emitMeasuredSize({ source: "measure" });
    },
    [emitMeasuredSize],
  );

  const handleCellMetricsChange = useCallback(
    (metrics: TerminalGridCellMetrics) => {
      metricsRef.current = metrics;
      emitMeasuredSize({ source: "measure" });
    },
    [emitMeasuredSize],
  );

  const applyScroll = useCallback(
    (direction: "up" | "down", rows: number) => {
      const terminal = terminalRef.current;
      const model = screenModelRef.current;
      if (!terminal || !model || rows <= 0) {
        return;
      }
      const visibleRows = resolveVisibleRows(terminal);
      const screen =
        direction === "up"
          ? model.scrollUp({ rows, visibleRows })
          : model.scrollDown({ rows, visibleRows });
      commitTerminalScreen(screen);
    },
    [commitTerminalScreen, resolveVisibleRows],
  );

  const returnToBottom = useCallback(() => {
    const terminal = terminalRef.current;
    const model = screenModelRef.current;
    if (!terminal || !model) {
      return;
    }
    const screen = model.returnToBottom({ visibleRows: resolveVisibleRows(terminal) });
    commitTerminalScreen(screen);
  }, [commitTerminalScreen, resolveVisibleRows]);

  const resolveSelectionViewport = useCallback((): TerminalSelectionViewport | null => {
    const screen = terminalScreenRef.current;
    const metrics = metricsRef.current;
    const layout = layoutRef.current;
    if (!screen || !metrics) {
      return null;
    }

    const visibleCols = layout
      ? Math.min(screen.viewport.cols, Math.max(1, Math.floor(layout.width / metrics.cellWidth)))
      : screen.viewport.cols;
    return {
      firstRow: screen.viewport.firstRow,
      rows: screen.viewport.grid.length,
      cols: visibleCols,
    };
  }, []);

  const resolveSelectionCoordinate = useCallback(
    (point: { x: number; y: number }): TerminalBufferCoordinate | null => {
      const metrics = metricsRef.current;
      const viewport = resolveSelectionViewport();
      if (!metrics || !viewport) {
        return null;
      }
      return hitTestTerminalSelectionCell({ point, metrics, viewport });
    },
    [resolveSelectionViewport],
  );

  const beginSelectionAtPoint = useCallback(
    (point: { x: number; y: number }) => {
      const terminal = terminalRef.current;
      if (!terminal) {
        return;
      }
      const coordinate = resolveSelectionCoordinate(point);
      if (!coordinate) {
        return;
      }
      selectionPressRef.current = {
        startX: point.x,
        startY: point.y,
        startedAt: Date.now(),
        status: "selecting",
      };
      const snapshot = selectionModelRef.current.begin({
        coordinate,
        bounds: terminal.getBufferBounds(),
      });
      commitSelectionRange(snapshot.range);
    },
    [commitSelectionRange, resolveSelectionCoordinate],
  );

  const updateSelectionAtPoint = useCallback(
    (point: { x: number; y: number }) => {
      const terminal = terminalRef.current;
      if (!terminal || selectionPressRef.current?.status !== "selecting") {
        return;
      }
      const coordinate = resolveSelectionCoordinate(point);
      if (!coordinate) {
        return;
      }
      const snapshot = selectionModelRef.current.update({
        coordinate,
        bounds: terminal.getBufferBounds(),
      });
      commitSelectionRange(snapshot.range);
    },
    [commitSelectionRange, resolveSelectionCoordinate],
  );

  const handlePanResponderScroll = useCallback(
    (currentDy: number) => {
      const cellHeight = metricsRef.current?.cellHeight;
      if (!cellHeight || cellHeight <= 0) {
        return;
      }
      const panState = panStateRef.current;
      const deltaY = currentDy - panState.lastDy;
      panState.lastDy = currentDy;
      panState.rowRemainder += deltaY;
      const rowDelta = Math.trunc(panState.rowRemainder / cellHeight);
      if (rowDelta === 0) {
        return;
      }
      panState.didScroll = true;
      panState.rowRemainder -= rowDelta * cellHeight;
      if (rowDelta > 0) {
        applyScroll("up", rowDelta);
        return;
      }
      applyScroll("down", Math.abs(rowDelta));
    },
    [applyScroll],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onStartShouldSetPanResponderCapture: () => true,
        onMoveShouldSetPanResponder: (_event, gesture) => {
          const intent = classifyTerminalGestureIntent({
            status: selectionRangeRef.current ? "selecting" : "pressing",
            dx: gesture.dx,
            dy: gesture.dy,
            vx: gesture.vx,
            vy: gesture.vy,
          });
          return intent === "scroll" || intent === "select";
        },
        onMoveShouldSetPanResponderCapture: (_event, gesture) => {
          const intent = classifyTerminalGestureIntent({
            status: selectionRangeRef.current ? "selecting" : "pressing",
            dx: gesture.dx,
            dy: gesture.dy,
            vx: gesture.vx,
            vy: gesture.vy,
          });
          return intent === "scroll" || intent === "select";
        },
        onPanResponderGrant: (event) => {
          panStateRef.current = {
            lastDy: 0,
            rowRemainder: 0,
            didScroll: false,
            didNavigate: false,
            movedBeyondTapTolerance: false,
            intent: null,
          };
          const point = {
            x: event.nativeEvent.locationX,
            y: event.nativeEvent.locationY,
          };
          const pressStatus = selectionRangeRef.current ? "selecting" : "pressing";
          selectionPressRef.current = {
            startX: point.x,
            startY: point.y,
            startedAt: Date.now(),
            status: pressStatus,
          };
          clearSelectionLongPressTimeout();
          if (pressStatus === "selecting") {
            return;
          }
          selectionLongPressTimeoutRef.current = setTimeout(() => {
            selectionLongPressTimeoutRef.current = null;
            const press = selectionPressRef.current;
            if (press?.status !== "pressing") {
              return;
            }
            beginSelectionAtPoint({ x: press.startX, y: press.startY });
          }, TERMINAL_GESTURE_LONG_PRESS_MS);
        },
        onPanResponderMove: (event, gesture) => {
          const selectionPress = selectionPressRef.current;
          if (selectionPress?.status === "selecting") {
            updateSelectionAtPoint(resolvePanResponderPoint(selectionPress, event, gesture));
            return;
          }

          const panState = panStateRef.current;
          if (Math.hypot(gesture.dx, gesture.dy) > TERMINAL_GESTURE_TAP_TOLERANCE_PX) {
            panState.movedBeyondTapTolerance = true;
          }
          if (panState.didScroll) {
            handlePanResponderScroll(gesture.dy);
            return;
          }
          if (panState.didNavigate) {
            return;
          }

          if (selectionPress?.status === "pressing") {
            const point = resolvePanResponderPoint(selectionPress, event, gesture);
            const dx = point.x - selectionPress.startX;
            const dy = point.y - selectionPress.startY;
            const intent = classifyTerminalGestureIntent({
              status: "pressing",
              dx,
              dy,
              vx: gesture.vx,
              vy: gesture.vy,
              elapsedMs: Date.now() - selectionPress.startedAt,
            });
            if (intent === "tap" || intent === "pending") {
              return;
            }

            clearSelectionLongPressTimeout();
            panState.intent = intent;

            if (intent === "scroll") {
              selectionPressRef.current = null;
              handlePanResponderScroll(gesture.dy);
              return;
            }

            if (intent === "select") {
              beginSelectionAtPoint({ x: selectionPress.startX, y: selectionPress.startY });
              updateSelectionAtPoint(point);
              return;
            }

            if (intent === "swipeRight") {
              panState.didNavigate = true;
              selectionPressRef.current = null;
              callbacksRef.current.onSwipeRight?.();
              return;
            }

            if (intent === "swipeLeft") {
              panState.didNavigate = true;
              selectionPressRef.current = null;
              callbacksRef.current.onSwipeLeft?.();
              return;
            }
          }
        },
        onPanResponderRelease: (event, gesture) => {
          clearSelectionLongPressTimeout();
          const selectionPress = selectionPressRef.current;
          if (selectionPress?.status === "selecting") {
            updateSelectionAtPoint(resolvePanResponderPoint(selectionPress, event, gesture));
          }
          selectionPressRef.current = null;
          const { didScroll, didNavigate, movedBeyondTapTolerance } = panStateRef.current;
          panStateRef.current = {
            lastDy: 0,
            rowRemainder: 0,
            didScroll: false,
            didNavigate: false,
            movedBeyondTapTolerance: false,
            intent: null,
          };
          const releaseAction = resolveTerminalGestureReleaseAction({
            status: selectionPress?.status ?? "idle",
            didScroll,
            didNavigate,
            movedBeyondTapTolerance,
            pressDurationMs: selectionPress ? Date.now() - selectionPress.startedAt : 0,
            longPressMs: TERMINAL_GESTURE_LONG_PRESS_MS,
            scrollMode: terminalScreenRef.current?.scroll.mode ?? "following",
          });
          if (releaseAction === "select" && selectionPress) {
            beginSelectionAtPoint({ x: selectionPress.startX, y: selectionPress.startY });
            return;
          }
          if (releaseAction === "focus") {
            focusTerminalFromTap();
          }
        },
        onPanResponderTerminate: () => {
          clearSelectionLongPressTimeout();
          selectionPressRef.current = null;
          panStateRef.current = {
            lastDy: 0,
            rowRemainder: 0,
            didScroll: false,
            didNavigate: false,
            movedBeyondTapTolerance: false,
            intent: null,
          };
        },
      }),
    [
      beginSelectionAtPoint,
      clearSelectionLongPressTimeout,
      focusTerminalFromTap,
      handlePanResponderScroll,
      updateSelectionAtPoint,
    ],
  );

  const backgroundColor = xtermTheme.background ?? "#0b0b0b";
  const rootStyle = useMemo<StyleProp<ViewStyle>>(
    () => [styles.root, { backgroundColor }],
    [backgroundColor],
  );

  const terminalState = terminalScreen?.viewport ?? null;
  const isScrolled = terminalScreen?.scroll.mode === "scrolled";
  const terminalGrid = terminalState ? (
    <TerminalGridView
      state={terminalState}
      xtermTheme={xtermTheme}
      fontFamily={fontFamily}
      fontSize={fontSize}
      style={styles.nativeGrid}
      selection={selectionRange}
      onCellMetricsChange={handleCellMetricsChange}
    />
  ) : null;

  return (
    <View onLayout={handleLayout} style={rootStyle} testID={testId}>
      <View {...panResponder.panHandlers} accessible={false} style={styles.nativeSurface}>
        {terminalGrid}
        <TerminalInput
          ref={inputRef}
          onFocus={handleTerminalFocus}
          onInput={handleTerminalInput}
          onTerminalKey={handleNativeTerminalKey}
        />
      </View>
      {isScrolled ? (
        <Pressable
          accessibilityLabel="Bottom"
          accessibilityRole="button"
          onPress={returnToBottom}
          style={styles.followButton}
          testID="terminal-follow-bottom"
        >
          <Text style={styles.followButtonText}>Bottom</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export default function TerminalEmulator(props: TerminalEmulatorProps) {
  return <NativeTerminalEmulator {...props} />;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
    position: "relative",
  },
  nativeSurface: {
    backgroundColor: "transparent",
    flex: 1,
  },
  nativeGrid: {
    flex: 1,
  },
  followButton: {
    position: "absolute",
    right: 12,
    bottom: 12,
    zIndex: 2,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: "rgba(32, 32, 32, 0.86)",
  },
  followButtonText: {
    color: "#f5f5f5",
    fontSize: 12,
    fontWeight: "600",
  },
});
