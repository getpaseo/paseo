"use dom";

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type Ref,
} from "react";
import type { DOMProps } from "expo/dom";
import { useDOMImperativeHandle, type DOMImperativeFactory } from "expo/dom";
import "@xterm/xterm/css/xterm.css";
import type { ITheme } from "@xterm/xterm";
import type { TerminalState } from "@getpaseo/protocol/messages";
import type { TerminalInputModeState } from "@getpaseo/protocol/terminal-input-mode";
import type { PendingTerminalModifiers } from "../utils/terminal-keys";
import {
  TerminalEmulatorRuntime,
  type TerminalOutputData,
} from "../terminal/runtime/terminal-emulator-runtime";
import type {
  TerminalLocalFileLinkSource,
  TerminalLocalFileLinkTarget,
} from "../terminal/local-links/terminal-local-link-provider";
import type { TerminalRendererReadyChange } from "../utils/terminal-renderer-readiness";
import { openExternalUrl } from "../utils/open-external-url";
import { focusWithRetries } from "../utils/web-focus";
import {
  extractTerminalDropPaths,
  isTerminalDragLeaveOutside,
  isTerminalFileDrag,
  prepareDroppedPathsForTerminal,
} from "../terminal/drop/terminal-file-drop";
import { getDesktopHost } from "@/desktop/host";

export interface TerminalEmulatorHandle {
  writeOutput: (data: TerminalOutputData) => void;
  restoreOutput: (data: TerminalOutputData) => void;
  renderSnapshot: (state: TerminalState | null) => void;
  clear: () => void;
  blur: () => void;
}

const HOST_DIV_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  minWidth: 0,
  width: "100%",
  height: "100%",
  overflow: "hidden",
  overscrollBehavior: "none",
  paddingTop: 0,
  paddingBottom: 0,
  paddingLeft: 0,
  paddingRight: 0,
};

function buildXtermThemeKey(theme: ITheme): string {
  const values: Array<string> = [
    theme.background,
    theme.foreground,
    theme.cursor,
    theme.cursorAccent,
    theme.selectionBackground,
    theme.selectionForeground,
    theme.black,
    theme.red,
    theme.green,
    theme.yellow,
    theme.blue,
    theme.magenta,
    theme.cyan,
    theme.white,
    theme.brightBlack,
    theme.brightRed,
    theme.brightGreen,
    theme.brightYellow,
    theme.brightBlue,
    theme.brightMagenta,
    theme.brightCyan,
    theme.brightWhite,
  ].map((value) => (typeof value === "string" ? value : ""));

  return values.join("|");
}

interface TerminalEmulatorProps {
  dom?: DOMProps;
  ref: Ref<TerminalEmulatorHandle>;
  streamKey: string;
  testId?: string;
  xtermTheme?: ITheme;
  scrollbackLines: number;
  fontFamily?: string;
  fontSize?: number;
  swipeGesturesEnabled?: boolean;
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  initialSnapshot?: TerminalState | null;
  onInput?: (data: string) => Promise<void> | void;
  onFocus?: () => Promise<void> | void;
  onResize?: (input: { rows: number; cols: number; shouldClaim: boolean }) => Promise<void> | void;
  onTerminalKey?: (input: {
    key: string;
    ctrl: boolean;
    shift: boolean;
    alt: boolean;
    meta: boolean;
  }) => Promise<void> | void;
  onPendingModifiersConsumed?: () => Promise<void> | void;
  onInputModeChange?: (state: TerminalInputModeState) => Promise<void> | void;
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

declare global {
  interface Window {}
}

function isTerminalState(value: unknown): value is TerminalState {
  return (
    typeof value === "object" &&
    value !== null &&
    "rows" in value &&
    "cols" in value &&
    "grid" in value
  );
}

export default function TerminalEmulator({
  ref,
  streamKey,
  testId = "terminal-surface",
  xtermTheme = {
    background: "#0b0b0b",
    foreground: "#e6e6e6",
    cursor: "#e6e6e6",
  },
  scrollbackLines,
  fontFamily,
  fontSize,
  swipeGesturesEnabled = false,
  onSwipeLeft,
  onSwipeRight,
  initialSnapshot = null,
  onInput,
  onFocus,
  onResize,
  onTerminalKey,
  onPendingModifiersConsumed,
  onInputModeChange,
  onResolveLocalFileLink,
  onOpenLocalFileLink,
  onRendererReadyChange,
  pendingModifiers = { ctrl: false, shift: false, alt: false },
  focusRequestToken = 0,
  resizeRequestToken = 0,
}: TerminalEmulatorProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<TerminalEmulatorRuntime | null>(null);
  const mountedThemeRef = useRef<ITheme>(xtermTheme);
  const fontFamilyRef = useRef(fontFamily);
  const fontSizeRef = useRef(fontSize);
  const scrollbackLinesRef = useRef(scrollbackLines);
  scrollbackLinesRef.current = scrollbackLines;
  fontFamilyRef.current = fontFamily;
  fontSizeRef.current = fontSize;
  const themeKey = useMemo(() => buildXtermThemeKey(xtermTheme), [xtermTheme]);
  const xtermThemeRef = useRef(xtermTheme);
  xtermThemeRef.current = xtermTheme;
  const onRendererReadyChangeRef = useRef(onRendererReadyChange);
  onRendererReadyChangeRef.current = onRendererReadyChange;
  const mountCallbacksRef = useRef({
    onInput,
    onResize,
    onTerminalKey,
    onPendingModifiersConsumed,
    onInputModeChange,
    onResolveLocalFileLink,
    onOpenLocalFileLink,
  });
  mountCallbacksRef.current = {
    onInput,
    onResize,
    onTerminalKey,
    onPendingModifiersConsumed,
    onInputModeChange,
    onResolveLocalFileLink,
    onOpenLocalFileLink,
  };
  const initialSnapshotRef = useRef(initialSnapshot);
  initialSnapshotRef.current = initialSnapshot;
  const pendingModifiersRef = useRef(pendingModifiers);
  pendingModifiersRef.current = pendingModifiers;
  const [isDropActive, setIsDropActive] = useState(false);
  const dropActiveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const domBridgeRef = useRef<DOMImperativeFactory | null>(null);
  useDOMImperativeHandle(
    domBridgeRef,
    (): DOMImperativeFactory => ({
      writeOutput: (...args) => {
        const data = args[0];
        if (data instanceof Uint8Array) runtimeRef.current?.write({ data });
      },
      restoreOutput: (...args) => {
        const data = args[0];
        if (data instanceof Uint8Array) runtimeRef.current?.restoreOutput({ data });
      },
      renderSnapshot: (...args) => {
        const state = args[0];
        if (state === null) {
          runtimeRef.current?.renderSnapshot({ state: null });
        } else if (isTerminalState(state)) {
          runtimeRef.current?.renderSnapshot({ state });
        }
      },
      clear: () => {
        runtimeRef.current?.clear();
      },
      blur: () => {
        runtimeRef.current?.blur();
      },
    }),
    [],
  );
  useImperativeHandle(
    ref,
    (): TerminalEmulatorHandle => ({
      writeOutput: (data: TerminalOutputData) => {
        runtimeRef.current?.write({ data });
      },
      restoreOutput: (data: TerminalOutputData) => {
        runtimeRef.current?.restoreOutput({ data });
      },
      renderSnapshot: (state: TerminalState | null) => {
        runtimeRef.current?.renderSnapshot({ state });
      },
      clear: () => {
        runtimeRef.current?.clear();
      },
      blur: () => {
        runtimeRef.current?.blur();
      },
    }),
    [],
  );

  useEffect(() => {
    const nextTheme = xtermThemeRef.current;
    mountedThemeRef.current = nextTheme;
    runtimeRef.current?.setTheme({ theme: nextTheme });
  }, [themeKey]);

  useEffect(() => {
    runtimeRef.current?.setScrollback({ lines: scrollbackLines });
  }, [scrollbackLines]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !swipeGesturesEnabled) {
      return () => {};
    }

    const SWIPE_MIN_PX = 22;
    const VERTICAL_CANCEL_PX = 12;
    const HORIZONTAL_DOMINANCE_RATIO = 1.2;

    let tracking = false;
    let activePointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let fired = false;

    const reset = () => {
      tracking = false;
      activePointerId = null;
      startX = 0;
      startY = 0;
      fired = false;
    };

    const shouldTreatAsVertical = (dx: number, dy: number) => {
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);
      if (absDy < VERTICAL_CANCEL_PX) {
        return false;
      }
      return absDy > absDx;
    };

    const shouldTreatAsHorizontal = (dx: number, dy: number) => {
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);
      if (absDx < SWIPE_MIN_PX) {
        return false;
      }
      if (absDy === 0) {
        return true;
      }
      return absDx / absDy >= HORIZONTAL_DOMINANCE_RATIO;
    };

    const onPointerDown = (event: PointerEvent) => {
      if (!event.isPrimary) {
        return;
      }
      tracking = true;
      fired = false;
      activePointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!tracking || fired) {
        return;
      }
      if (activePointerId !== null && event.pointerId !== activePointerId) {
        return;
      }

      const dx = event.clientX - startX;
      const dy = event.clientY - startY;

      if (shouldTreatAsVertical(dx, dy)) {
        reset();
        return;
      }

      if (!shouldTreatAsHorizontal(dx, dy)) {
        return;
      }

      fired = true;

      if (dx > 0) {
        onSwipeRight?.();
      } else {
        onSwipeLeft?.();
      }

      if (event.cancelable) {
        event.preventDefault();
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      if (activePointerId !== null && event.pointerId !== activePointerId) {
        return;
      }
      reset();
    };

    const onPointerCancel = (event: PointerEvent) => {
      if (activePointerId !== null && event.pointerId !== activePointerId) {
        return;
      }
      reset();
    };

    root.addEventListener("pointerdown", onPointerDown, { passive: true });
    root.addEventListener("pointermove", onPointerMove, { passive: false });
    root.addEventListener("pointerup", onPointerUp, { passive: true });
    root.addEventListener("pointercancel", onPointerCancel, { passive: true });

    return () => {
      root.removeEventListener("pointerdown", onPointerDown);
      root.removeEventListener("pointermove", onPointerMove);
      root.removeEventListener("pointerup", onPointerUp);
      root.removeEventListener("pointercancel", onPointerCancel);
    };
  }, [onSwipeLeft, onSwipeRight, swipeGesturesEnabled]);

  useEffect(() => {
    const host = hostRef.current;
    const root = rootRef.current;
    if (!host || !root) {
      return () => {};
    }

    const runtime = new TerminalEmulatorRuntime();
    runtimeRef.current = runtime;
    runtime.setCallbacks({
      callbacks: {
        ...mountCallbacksRef.current,
        onOpenExternalUrl: openExternalUrl,
      },
    });
    runtime.setPendingModifiers({ pendingModifiers: pendingModifiersRef.current });
    runtime.mount({
      root,
      host,
      initialSnapshot: initialSnapshotRef.current,
      scrollback: scrollbackLinesRef.current,
      theme: mountedThemeRef.current,
      fontFamily: fontFamilyRef.current,
      fontSize: fontSizeRef.current,
    });
    onRendererReadyChangeRef.current?.({ streamKey, isReady: true });

    return () => {
      runtime.unmount();
      onRendererReadyChangeRef.current?.({ streamKey, isReady: false });
      if (runtimeRef.current === runtime) {
        runtimeRef.current = null;
      }
    };
  }, [streamKey]);

  useEffect(() => {
    runtimeRef.current?.setCallbacks({
      callbacks: {
        onInput,
        onResize,
        onTerminalKey,
        onPendingModifiersConsumed,
        onInputModeChange,
        onResolveLocalFileLink,
        onOpenLocalFileLink,
        onOpenExternalUrl: openExternalUrl,
      },
    });
  }, [
    onInput,
    onInputModeChange,
    onOpenLocalFileLink,
    onPendingModifiersConsumed,
    onResolveLocalFileLink,
    onResize,
    onTerminalKey,
  ]);

  useEffect(() => {
    runtimeRef.current?.setPendingModifiers({ pendingModifiers });
  }, [pendingModifiers]);

  useEffect(() => {
    runtimeRef.current?.setFont({ fontFamily, fontSize });
  }, [fontFamily, fontSize]);

  useEffect(() => {
    if (focusRequestToken <= 0) {
      return () => {};
    }
    runtimeRef.current?.resize({ force: true, shouldClaim: true });
    return focusWithRetries({
      focus: () => {
        runtimeRef.current?.focus();
      },
      isFocused: () => {
        const root = rootRef.current;
        if (!root) {
          return false;
        }
        const active = typeof document !== "undefined" ? document.activeElement : null;
        return active instanceof HTMLElement && root.contains(active);
      },
    });
  }, [focusRequestToken]);

  useEffect(() => {
    if (resizeRequestToken <= 0) {
      return;
    }
    runtimeRef.current?.resize({ force: true, shouldClaim: true });
  }, [resizeRequestToken]);

  const showTerminalContextMenu = useCallback(() => {
    const showContextMenu = window.paseoDesktop?.menu?.showContextMenu;
    if (typeof showContextMenu !== "function") {
      return;
    }

    const hasSelection = Boolean(window.getSelection()?.toString());
    void showContextMenu({
      kind: "terminal",
      hasSelection,
    });
  }, []);

  const handleRootPointerDown = useCallback(() => {
    onFocus?.();
    runtimeRef.current?.focus();
  }, [onFocus]);

  const handleRootContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      showTerminalContextMenu();
    },
    [showTerminalContextMenu],
  );

  const clearDropActiveTimeout = useCallback(() => {
    if (dropActiveTimeoutRef.current === null) {
      return;
    }
    clearTimeout(dropActiveTimeoutRef.current);
    dropActiveTimeoutRef.current = null;
  }, []);

  const clearTerminalDropActive = useCallback(() => {
    clearDropActiveTimeout();
    setIsDropActive(false);
  }, [clearDropActiveTimeout]);

  const keepTerminalDropActive = useCallback(() => {
    clearDropActiveTimeout();
    setIsDropActive(true);
    dropActiveTimeoutRef.current = setTimeout(() => {
      dropActiveTimeoutRef.current = null;
      setIsDropActive(false);
    }, 180);
  }, [clearDropActiveTimeout]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return () => {};
    }

    const handleDragEnter = (event: DragEvent) => {
      if (!isTerminalFileDrag(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      keepTerminalDropActive();
    };

    const handleDragOver = (event: DragEvent) => {
      if (!isTerminalFileDrag(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
      keepTerminalDropActive();
    };

    const handleDrop = (event: DragEvent) => {
      if (!isTerminalFileDrag(event.dataTransfer)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      clearTerminalDropActive();

      const bridge = getDesktopHost();
      const paths = extractTerminalDropPaths(event.dataTransfer, bridge);
      if (paths.length === 0) {
        return;
      }

      runtimeRef.current?.focus();
      mountCallbacksRef.current.onInput?.(prepareDroppedPathsForTerminal(paths, bridge));
    };

    root.addEventListener("dragenter", handleDragEnter, { capture: true });
    root.addEventListener("dragover", handleDragOver, { capture: true });
    root.addEventListener("drop", handleDrop, { capture: true });
    window.addEventListener("dragend", clearTerminalDropActive);
    window.addEventListener("drop", clearTerminalDropActive);

    return () => {
      root.removeEventListener("dragenter", handleDragEnter, { capture: true });
      root.removeEventListener("dragover", handleDragOver, { capture: true });
      root.removeEventListener("drop", handleDrop, { capture: true });
      window.removeEventListener("dragend", clearTerminalDropActive);
      window.removeEventListener("drop", clearTerminalDropActive);
      clearDropActiveTimeout();
    };
  }, [clearDropActiveTimeout, clearTerminalDropActive, keepTerminalDropActive]);

  const handleRootDragLeave = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!isTerminalFileDrag(event.dataTransfer)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (
        !isTerminalDragLeaveOutside({
          currentTarget: event.currentTarget,
          relatedTarget: event.relatedTarget,
        })
      ) {
        return;
      }
      clearTerminalDropActive();
    },
    [clearTerminalDropActive],
  );

  const rootDivStyle = useMemo<CSSProperties>(
    () => ({
      position: "relative",
      display: "flex",
      width: "100%",
      height: "100%",
      minHeight: 0,
      minWidth: 0,
      backgroundColor: xtermTheme.background ?? "#0b0b0b",
      overflow: "hidden",
      overscrollBehavior: "none",
      touchAction: "pan-y",
    }),
    [xtermTheme.background],
  );
  const dropOverlayStyle = useMemo<CSSProperties>(
    () => ({
      position: "absolute",
      inset: 0,
      zIndex: 9,
      border: "1px solid rgba(78, 161, 255, 0.72)",
      backgroundColor: "rgba(78, 161, 255, 0.16)",
      opacity: isDropActive ? 1 : 0,
      pointerEvents: "none",
      transition: "opacity 120ms ease-out",
    }),
    [isDropActive],
  );
  return (
    <div
      ref={rootRef}
      data-testid={testId}
      data-terminal-scrollbar-root="true"
      style={rootDivStyle}
      onPointerDown={handleRootPointerDown}
      onContextMenu={handleRootContextMenu}
      onDragLeave={handleRootDragLeave}
    >
      <div ref={hostRef} style={HOST_DIV_STYLE} />
      <div style={dropOverlayStyle} />
    </div>
  );
}
