"use dom";

import { useEffect, useMemo, useRef, useState, type Ref } from "react";
import type { DOMProps } from "expo/dom";
import { useDOMImperativeHandle, type DOMImperativeFactory } from "expo/dom";
import "@xterm/xterm/css/xterm.css";
import type { ITheme } from "@xterm/xterm";
import type { TerminalState } from "@server/shared/messages";
import type { PendingTerminalModifiers } from "../utils/terminal-keys";
import { TerminalEmulatorRuntime } from "../terminal/runtime/terminal-emulator-runtime";
import { openExternalUrl } from "../utils/open-external-url";
import { focusWithRetries } from "../utils/web-focus";
import {
  computeScrollOffsetFromDragDelta,
  computeVerticalScrollbarGeometry,
} from "./web-desktop-scrollbar.math";

export interface TerminalEmulatorHandle {
  writeOutput: (text: string) => void;
  renderSnapshot: (state: TerminalState | null) => void;
  clear: () => void;
}

const SCROLLBAR_HANDLE_WIDTH_IDLE = 6;
const SCROLLBAR_HANDLE_WIDTH_ACTIVE = 9;
const SCROLLBAR_HANDLE_GRAB_WIDTH = 18;
const SCROLLBAR_HANDLE_GRAB_VERTICAL_PADDING = 8;
const SCROLLBAR_HANDLE_OPACITY_VISIBLE = 0.62;
const SCROLLBAR_HANDLE_OPACITY_HOVERED = 0.78;
const SCROLLBAR_HANDLE_OPACITY_DRAGGING = 0.9;
const SCROLLBAR_HANDLE_FADE_DURATION_MS = 220;
const SCROLLBAR_HANDLE_WIDTH_TRANSITION_DURATION_MS = 240;
const SCROLLBAR_HANDLE_TRAVEL_DURATION_MS = 90;
const SCROLLBAR_HANDLE_SCROLL_VISIBILITY_MS = 1_200;
const SCROLLBAR_HANDLE_SCROLL_ACTIVE_MS = 110;
const WEBKIT_SCROLLBAR_STYLE_ID = "terminal-emulator-webkit-scrollbar-style";

type ViewportMetrics = {
  offset: number;
  viewportSize: number;
  contentSize: number;
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
  swipeGesturesEnabled?: boolean;
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  initialSnapshot?: TerminalState | null;
  onInput?: (data: string) => Promise<void> | void;
  onResize?: (input: { rows: number; cols: number }) => Promise<void> | void;
  onTerminalKey?: (input: {
    key: string;
    ctrl: boolean;
    shift: boolean;
    alt: boolean;
    meta: boolean;
  }) => Promise<void> | void;
  onPendingModifiersConsumed?: () => Promise<void> | void;
  pendingModifiers?: PendingTerminalModifiers;
  focusRequestToken?: number;
  resizeRequestToken?: number;
}

declare global {
  interface Window {}
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function ensureTerminalScrollbarStyle(): void {
  if (typeof document === "undefined") {
    return;
  }
  if (document.getElementById(WEBKIT_SCROLLBAR_STYLE_ID)) {
    return;
  }

  const styleElement = document.createElement("style");
  styleElement.id = WEBKIT_SCROLLBAR_STYLE_ID;
  styleElement.textContent = `
    [data-terminal-scrollbar-root="true"] .xterm-viewport {
      scrollbar-width: none;
      -ms-overflow-style: none;
    }

    [data-terminal-scrollbar-root="true"] .xterm-viewport::-webkit-scrollbar {
      width: 0;
      height: 0;
    }
  `;
  document.head.appendChild(styleElement);
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
  swipeGesturesEnabled = false,
  onSwipeLeft,
  onSwipeRight,
  initialSnapshot = null,
  onInput,
  onResize,
  onTerminalKey,
  onPendingModifiersConsumed,
  pendingModifiers = { ctrl: false, shift: false, alt: false },
  focusRequestToken = 0,
  resizeRequestToken = 0,
}: TerminalEmulatorProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<TerminalEmulatorRuntime | null>(null);
  const mountedThemeRef = useRef<ITheme>(xtermTheme);
  const viewportRef = useRef<HTMLElement | null>(null);
  const dragStartOffsetRef = useRef(0);
  const dragStartClientYRef = useRef(0);
  const scrollVisibilityTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollActiveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastObservedOffsetRef = useRef<number | null>(null);
  const themeKey = useMemo(() => buildXtermThemeKey(xtermTheme), [xtermTheme]);
  const [viewportMetrics, setViewportMetrics] = useState<ViewportMetrics>({
    offset: 0,
    viewportSize: 0,
    contentSize: 0,
  });
  const [isHandleHovered, setIsHandleHovered] = useState(false);
  const [isDraggingScrollbar, setIsDraggingScrollbar] = useState(false);
  const [isScrollVisible, setIsScrollVisible] = useState(false);
  const [isScrollActive, setIsScrollActive] = useState(false);

  useDOMImperativeHandle(
    ref as Ref<DOMImperativeFactory>,
    () =>
      ({
        writeOutput: (text: string) => {
          runtimeRef.current?.write({ text });
        },
        renderSnapshot: (state: TerminalState | null) => {
          runtimeRef.current?.renderSnapshot({ state });
        },
        clear: () => {
          runtimeRef.current?.clear();
        },
      }) as unknown as DOMImperativeFactory,
    [],
  );

  useEffect(() => {
    mountedThemeRef.current = xtermTheme;
    runtimeRef.current?.setTheme({ theme: xtermTheme });
  }, [themeKey]);

  useEffect(() => {
    ensureTerminalScrollbarStyle();
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !swipeGesturesEnabled) {
      return;
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
      return;
    }

    const runtime = new TerminalEmulatorRuntime();
    runtimeRef.current = runtime;
    runtime.setCallbacks({
      callbacks: {
        onInput,
        onResize,
        onTerminalKey,
        onPendingModifiersConsumed,
        onOpenExternalUrl: openExternalUrl,
      },
    });
    runtime.setPendingModifiers({ pendingModifiers });
    runtime.mount({
      root,
      host,
      initialSnapshot,
      theme: mountedThemeRef.current,
    });

    return () => {
      runtime.unmount();
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
        onOpenExternalUrl: openExternalUrl,
      },
    });
  }, [onInput, onPendingModifiersConsumed, onResize, onTerminalKey]);

  useEffect(() => {
    runtimeRef.current?.setPendingModifiers({ pendingModifiers });
  }, [pendingModifiers]);

  useEffect(() => {
    if (focusRequestToken <= 0) {
      return;
    }
    runtimeRef.current?.resize({ force: true });
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
    runtimeRef.current?.resize({ force: true });
  }, [resizeRequestToken]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const viewportElement = host.querySelector<HTMLElement>(".xterm-viewport");
    if (!viewportElement) {
      viewportRef.current = null;
      setViewportMetrics({ offset: 0, viewportSize: 0, contentSize: 0 });
      return;
    }

    viewportRef.current = viewportElement;

    const updateViewportMetrics = () => {
      setViewportMetrics({
        offset: Math.max(0, viewportElement.scrollTop),
        viewportSize: Math.max(0, viewportElement.clientHeight),
        contentSize: Math.max(0, viewportElement.scrollHeight),
      });
    };

    updateViewportMetrics();

    const handleViewportScroll = () => {
      updateViewportMetrics();
    };

    const resizeObserver = new ResizeObserver(() => {
      updateViewportMetrics();
    });
    resizeObserver.observe(viewportElement);
    const scrollAreaElement = host.querySelector<HTMLElement>(".xterm-scroll-area");
    if (scrollAreaElement) {
      resizeObserver.observe(scrollAreaElement);
    }

    const mutationObserver = new MutationObserver(() => {
      updateViewportMetrics();
    });
    mutationObserver.observe(host, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class"],
    });

    viewportElement.addEventListener("scroll", handleViewportScroll, { passive: true });

    return () => {
      viewportElement.removeEventListener("scroll", handleViewportScroll);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      if (viewportRef.current === viewportElement) {
        viewportRef.current = null;
      }
    };
  }, [streamKey]);

  useEffect(() => {
    const maxScrollOffset = Math.max(0, viewportMetrics.contentSize - viewportMetrics.viewportSize);
    const normalizedOffset = clamp(viewportMetrics.offset, 0, maxScrollOffset);
    if (maxScrollOffset <= 0 || viewportMetrics.viewportSize <= 0) {
      setIsScrollVisible(false);
      setIsScrollActive(false);
      lastObservedOffsetRef.current = null;
      return;
    }

    const previousOffset = lastObservedOffsetRef.current;
    lastObservedOffsetRef.current = normalizedOffset;
    if (previousOffset === null || Math.abs(previousOffset - normalizedOffset) <= 0.5) {
      return;
    }

    setIsScrollVisible(true);
    if (scrollVisibilityTimeoutRef.current !== null) {
      clearTimeout(scrollVisibilityTimeoutRef.current);
    }
    scrollVisibilityTimeoutRef.current = setTimeout(() => {
      setIsScrollVisible(false);
      scrollVisibilityTimeoutRef.current = null;
    }, SCROLLBAR_HANDLE_SCROLL_VISIBILITY_MS);

    setIsScrollActive(true);
    if (scrollActiveTimeoutRef.current !== null) {
      clearTimeout(scrollActiveTimeoutRef.current);
    }
    scrollActiveTimeoutRef.current = setTimeout(() => {
      setIsScrollActive(false);
      scrollActiveTimeoutRef.current = null;
    }, SCROLLBAR_HANDLE_SCROLL_ACTIVE_MS);
  }, [viewportMetrics.contentSize, viewportMetrics.offset, viewportMetrics.viewportSize]);

  useEffect(() => {
    return () => {
      if (scrollVisibilityTimeoutRef.current !== null) {
        clearTimeout(scrollVisibilityTimeoutRef.current);
      }
      if (scrollActiveTimeoutRef.current !== null) {
        clearTimeout(scrollActiveTimeoutRef.current);
      }
    };
  }, []);

  const scrollbarGeometry = useMemo(
    () =>
      computeVerticalScrollbarGeometry({
        viewportSize: viewportMetrics.viewportSize,
        contentSize: viewportMetrics.contentSize,
        offset: viewportMetrics.offset,
      }),
    [viewportMetrics.contentSize, viewportMetrics.offset, viewportMetrics.viewportSize],
  );

  useEffect(() => {
    if (!isDraggingScrollbar) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const dragDelta = event.clientY - dragStartClientYRef.current;
      const nextOffset = computeScrollOffsetFromDragDelta({
        startOffset: dragStartOffsetRef.current,
        dragDelta,
        maxScrollOffset: scrollbarGeometry.maxScrollOffset,
        maxHandleOffset: scrollbarGeometry.maxHandleOffset,
      });
      const viewportElement = viewportRef.current;
      if (!viewportElement) {
        return;
      }
      viewportElement.scrollTop = nextOffset;
      setViewportMetrics({
        offset: nextOffset,
        viewportSize: Math.max(0, viewportElement.clientHeight),
        contentSize: Math.max(0, viewportElement.scrollHeight),
      });
    };

    const stopDragging = () => {
      setIsDraggingScrollbar(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
    };
  }, [isDraggingScrollbar, scrollbarGeometry.maxHandleOffset, scrollbarGeometry.maxScrollOffset]);

  const handleVisible =
    scrollbarGeometry.isVisible && (isDraggingScrollbar || isScrollVisible || isHandleHovered);
  const handleOpacity = isDraggingScrollbar
    ? SCROLLBAR_HANDLE_OPACITY_DRAGGING
    : isHandleHovered
      ? SCROLLBAR_HANDLE_OPACITY_HOVERED
      : isScrollVisible
        ? SCROLLBAR_HANDLE_OPACITY_VISIBLE
        : 0;
  const handleWidth =
    isDraggingScrollbar || isHandleHovered
      ? SCROLLBAR_HANDLE_WIDTH_ACTIVE
      : SCROLLBAR_HANDLE_WIDTH_IDLE;
  const thumbRegionOffset = Math.max(
    0,
    scrollbarGeometry.handleOffset - SCROLLBAR_HANDLE_GRAB_VERTICAL_PADDING,
  );
  const thumbRegionHeight = Math.min(
    viewportMetrics.viewportSize - thumbRegionOffset,
    scrollbarGeometry.handleSize + SCROLLBAR_HANDLE_GRAB_VERTICAL_PADDING * 2,
  );
  const handleInsetTop = Math.max(0, (thumbRegionHeight - scrollbarGeometry.handleSize) / 2);
  const handleTravelDurationMs =
    isDraggingScrollbar || isScrollActive ? 0 : SCROLLBAR_HANDLE_TRAVEL_DURATION_MS;
  const handleContextMenu = () => {
    const showContextMenu = window.paseoDesktop?.menu?.showContextMenu;
    if (typeof showContextMenu !== "function") {
      return;
    }

    const hasSelection = Boolean(window.getSelection()?.toString());
    void showContextMenu({
      kind: "terminal",
      hasSelection,
    });
  };

  return (
    <div
      ref={rootRef}
      data-testid={testId}
      data-terminal-scrollbar-root="true"
      style={{
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
      }}
      onPointerDown={() => {
        runtimeRef.current?.focus();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        handleContextMenu();
      }}
    >
      <div
        ref={hostRef}
        style={{
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
        }}
      />
      {scrollbarGeometry.isVisible ? (
        <div
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            width: 12,
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-start",
            zIndex: 10,
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              position: "absolute",
              top: 0,
              right: -3,
              width: SCROLLBAR_HANDLE_GRAB_WIDTH,
              height: thumbRegionHeight,
              transform: `translateY(${thumbRegionOffset}px)`,
              cursor: isDraggingScrollbar ? "grabbing" : "grab",
              touchAction: "none",
              userSelect: "none",
              transitionProperty: "transform",
              transitionDuration: `${handleTravelDurationMs}ms`,
              transitionTimingFunction: "linear",
              pointerEvents: handleVisible ? "auto" : "none",
            }}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              dragStartOffsetRef.current = clamp(
                viewportMetrics.offset,
                0,
                scrollbarGeometry.maxScrollOffset,
              );
              dragStartClientYRef.current = event.clientY;
              setIsDraggingScrollbar(true);
            }}
            onPointerEnter={() => {
              if (!isScrollVisible && !isDraggingScrollbar) {
                return;
              }
              setIsHandleHovered(true);
            }}
            onPointerLeave={() => {
              setIsHandleHovered(false);
            }}
          >
            <div
              style={{
                marginTop: handleInsetTop,
                height: scrollbarGeometry.handleSize,
                width: handleWidth,
                borderRadius: 999,
                alignSelf: "center",
                backgroundColor: "rgba(113, 113, 122, 1)",
                opacity: handleOpacity,
                transitionProperty: "opacity, width, background-color",
                transitionDuration: `${SCROLLBAR_HANDLE_FADE_DURATION_MS}ms, ${SCROLLBAR_HANDLE_WIDTH_TRANSITION_DURATION_MS}ms, ${SCROLLBAR_HANDLE_FADE_DURATION_MS}ms`,
                transitionTimingFunction: "ease-out, cubic-bezier(0.22, 0.75, 0.2, 1), ease-out",
              }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
