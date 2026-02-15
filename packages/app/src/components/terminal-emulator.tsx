"use dom";

import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { DOMProps } from "expo/dom";
import "@xterm/xterm/css/xterm.css";
import {
  type PendingTerminalModifiers,
  isTerminalModifierDomKey,
  mergeTerminalModifiers,
  normalizeDomTerminalKey,
  normalizeTerminalTransportKey,
  shouldInterceptDomTerminalKey,
} from "../utils/terminal-keys";

interface TerminalEmulatorProps {
  dom?: DOMProps;
  streamKey: string;
  outputText: string;
  testId?: string;
  backgroundColor?: string;
  foregroundColor?: string;
  cursorColor?: string;
  onInput?: (data: string) => Promise<void> | void;
  onResize?: (rows: number, cols: number) => Promise<void> | void;
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
}

declare global {
  interface Window {
    __paseoTerminal?: Terminal;
  }
}

export default function TerminalEmulator({
  streamKey,
  outputText,
  testId = "terminal-surface",
  backgroundColor = "#0b0b0b",
  foregroundColor = "#e6e6e6",
  cursorColor = "#e6e6e6",
  onInput,
  onResize,
  onTerminalKey,
  onPendingModifiersConsumed,
  pendingModifiers = { ctrl: false, shift: false, alt: false },
  focusRequestToken = 0,
}: TerminalEmulatorProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const renderedOutputRef = useRef("");
  const lastSizeRef = useRef<{ rows: number; cols: number } | null>(null);
  const onInputRef = useRef<TerminalEmulatorProps["onInput"]>(onInput);
  const onResizeRef = useRef<TerminalEmulatorProps["onResize"]>(onResize);
  const onTerminalKeyRef = useRef<TerminalEmulatorProps["onTerminalKey"]>(onTerminalKey);
  const onPendingModifiersConsumedRef = useRef<
    TerminalEmulatorProps["onPendingModifiersConsumed"]
  >(onPendingModifiersConsumed);
  const pendingModifiersRef = useRef<PendingTerminalModifiers>(pendingModifiers);

  useEffect(() => {
    onInputRef.current = onInput;
  }, [onInput]);

  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);

  useEffect(() => {
    onTerminalKeyRef.current = onTerminalKey;
  }, [onTerminalKey]);

  useEffect(() => {
    onPendingModifiersConsumedRef.current = onPendingModifiersConsumed;
  }, [onPendingModifiersConsumed]);

  useEffect(() => {
    pendingModifiersRef.current = pendingModifiers;
  }, [pendingModifiers]);

  useEffect(() => {
    const host = hostRef.current;
    const root = rootRef.current;
    if (!host || !root) {
      return;
    }

    renderedOutputRef.current = "";
    lastSizeRef.current = null;
    host.innerHTML = "";

    const terminal = new Terminal({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: "'SF Mono', Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 10_000,
      theme: {
        background: backgroundColor,
        foreground: foregroundColor,
        cursor: cursorColor,
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);

    const documentElement = document.documentElement;
    const body = document.body;
    const rootContainer = root.parentElement;

    const previousDocumentElementOverflow = documentElement.style.overflow;
    const previousDocumentElementWidth = documentElement.style.width;
    const previousDocumentElementHeight = documentElement.style.height;

    const previousBodyOverflow = body.style.overflow;
    const previousBodyWidth = body.style.width;
    const previousBodyHeight = body.style.height;
    const previousBodyMargin = body.style.margin;
    const previousBodyPadding = body.style.padding;

    const previousRootOverflow = rootContainer?.style.overflow ?? "";
    const previousRootWidth = rootContainer?.style.width ?? "";
    const previousRootHeight = rootContainer?.style.height ?? "";

    // Force document to follow WebView bounds; xterm viewport owns scrollback.
    documentElement.style.overflow = "hidden";
    documentElement.style.width = "100%";
    documentElement.style.height = "100%";

    body.style.overflow = "hidden";
    body.style.width = "100%";
    body.style.height = "100%";
    body.style.margin = "0";
    body.style.padding = "0";

    if (rootContainer) {
      rootContainer.style.overflow = "hidden";
      rootContainer.style.width = "100%";
      rootContainer.style.height = "100%";
    }

    const viewportElement = host.querySelector<HTMLElement>(".xterm-viewport");
    const screenElement = host.querySelector<HTMLElement>(".xterm-screen");
    const previousViewportOverscroll = viewportElement?.style.overscrollBehavior ?? "";
    const previousViewportTouchAction = viewportElement?.style.touchAction ?? "";
    const previousViewportOverflowY = viewportElement?.style.overflowY ?? "";
    const previousViewportOverflowX = viewportElement?.style.overflowX ?? "";
    const previousViewportPointerEvents = viewportElement?.style.pointerEvents ?? "";
    const previousViewportWebkitOverflowScrolling =
      viewportElement?.style.getPropertyValue("-webkit-overflow-scrolling") ?? "";
    if (viewportElement) {
      viewportElement.style.overscrollBehavior = "none";
      viewportElement.style.touchAction = "pan-y";
      viewportElement.style.overflowY = "auto";
      viewportElement.style.overflowX = "hidden";
      viewportElement.style.pointerEvents = "auto";
      viewportElement.style.setProperty("-webkit-overflow-scrolling", "touch");
    }
    const previousScreenPointerEvents = screenElement?.style.pointerEvents ?? "";
    if (screenElement) {
      // xterm renders the screen layer above the viewport. Disable hit-testing on that layer
      // so touch drags can reach the scrollable viewport on mobile.
      screenElement.style.pointerEvents = "none";
    }

    terminalRef.current = terminal;
    window.__paseoTerminal = terminal;

    const fitAndEmitResize = (force = false) => {
      const handler = onResizeRef.current;
      if (!handler) {
        return;
      }

      try {
        fitAddon.fit();
      } catch {
        return;
      }

      const rows = terminal.rows;
      const cols = terminal.cols;
      const previous = lastSizeRef.current;
      if (!force && previous && previous.rows === rows && previous.cols === cols) {
        return;
      }

      lastSizeRef.current = { rows, cols };
      void handler(rows, cols);
    };

    fitAndEmitResize(true);

    const inputDisposable = terminal.onData((data) => {
      const handler = onInputRef.current;
      if (!handler) {
        return;
      }
      void handler(data);
    });

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || event.isComposing) {
        return true;
      }

      const normalizedKey = normalizeDomTerminalKey(event.key);
      if (!normalizedKey || isTerminalModifierDomKey(event.key)) {
        return true;
      }

      const pending = pendingModifiersRef.current;
      if (
        !shouldInterceptDomTerminalKey({
          key: normalizedKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          pendingModifiers: pending,
        })
      ) {
        return true;
      }

      const modifiers = mergeTerminalModifiers({
        pendingModifiers: pending,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
      });

      const keyPayload = {
        key: normalizeTerminalTransportKey(normalizedKey),
        ...modifiers,
      };
      onTerminalKeyRef.current?.(keyPayload);

      if (pending.ctrl || pending.shift || pending.alt) {
        onPendingModifiersConsumedRef.current?.();
      }

      event.preventDefault();
      event.stopPropagation();
      return false;
    });

    let touchScrollRemainderPx = 0;
    const touchScrollLineHeightPx = (() => {
      const row = host.querySelector<HTMLElement>(".xterm-rows > div");
      const measured = row?.getBoundingClientRect().height;
      return measured && measured > 0 ? measured : 18;
    })();
    const activeTouchRef: {
      identifier: number;
      startX: number;
      startY: number;
      lastX: number;
      lastY: number;
      mode: "vertical" | "horizontal" | null;
    } = {
      identifier: -1,
      startX: 0,
      startY: 0,
      lastX: 0,
      lastY: 0,
      mode: null,
    };
    const rootTouchStartHandler = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        touchScrollRemainderPx = 0;
        activeTouchRef.identifier = -1;
        activeTouchRef.mode = null;
        return;
      }
      const touch = event.touches[0];
      if (!touch) {
        touchScrollRemainderPx = 0;
        activeTouchRef.identifier = -1;
        activeTouchRef.mode = null;
        return;
      }
      activeTouchRef.identifier = touch.identifier;
      activeTouchRef.startX = touch.clientX;
      activeTouchRef.startY = touch.clientY;
      activeTouchRef.lastX = touch.clientX;
      activeTouchRef.lastY = touch.clientY;
      activeTouchRef.mode = null;
      touchScrollRemainderPx = 0;
    };
    const rootTouchMoveHandler = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        return;
      }
      const touch = Array.from(event.touches).find(
        (candidate) => candidate.identifier === activeTouchRef.identifier
      );
      if (!touch) {
        return;
      }

      const totalDeltaX = touch.clientX - activeTouchRef.startX;
      const totalDeltaY = touch.clientY - activeTouchRef.startY;
      if (activeTouchRef.mode === null) {
        const absX = Math.abs(totalDeltaX);
        const absY = Math.abs(totalDeltaY);
        if (absX > 8 || absY > 8) {
          activeTouchRef.mode = absY >= absX ? "vertical" : "horizontal";
        }
      }

      const deltaY = touch.clientY - activeTouchRef.lastY;
      activeTouchRef.lastX = touch.clientX;
      activeTouchRef.lastY = touch.clientY;

      if (activeTouchRef.mode !== "vertical") {
        return;
      }

      // Manual vertical touch scrolling fallback for xterm's layered DOM.
      touchScrollRemainderPx += deltaY;
      const lineDelta = Math.trunc(touchScrollRemainderPx / touchScrollLineHeightPx);
      if (lineDelta !== 0) {
        const appliedLineDelta = -lineDelta;
        terminal.scrollLines(appliedLineDelta);
        touchScrollRemainderPx -= lineDelta * touchScrollLineHeightPx;
      }
      event.preventDefault();
    };
    const rootTouchEndHandler = (event: TouchEvent) => {
      const changed = Array.from(event.changedTouches).some(
        (touch) => touch.identifier === activeTouchRef.identifier
      );
      if (changed || event.touches.length === 0) {
        touchScrollRemainderPx = 0;
        activeTouchRef.identifier = -1;
        activeTouchRef.mode = null;
      }
    };
    const rootTouchCancelHandler = () => {
      touchScrollRemainderPx = 0;
      activeTouchRef.identifier = -1;
      activeTouchRef.mode = null;
    };
    root.addEventListener("touchstart", rootTouchStartHandler, { passive: true });
    root.addEventListener("touchmove", rootTouchMoveHandler, { passive: false });
    root.addEventListener("touchend", rootTouchEndHandler, { passive: true });
    root.addEventListener("touchcancel", rootTouchCancelHandler, { passive: true });

    const resizeObserver = new ResizeObserver(() => {
      fitAndEmitResize();
    });
    resizeObserver.observe(root);
    resizeObserver.observe(host);

    const windowResizeHandler = () => fitAndEmitResize();
    window.addEventListener("resize", windowResizeHandler);

    const visualViewport = window.visualViewport;
    const visualViewportResizeHandler = () => fitAndEmitResize();
    visualViewport?.addEventListener("resize", visualViewportResizeHandler);

    // Safety net for keyboard/layout transitions that can skip callbacks.
    const fitInterval = window.setInterval(() => {
      fitAndEmitResize();
    }, 250);

    const fitTimeoutHandles = [0, 16, 48, 120, 250, 500, 1_000, 2_000].map((delay) =>
      window.setTimeout(() => {
        fitAndEmitResize(true);
      }, delay)
    );

    const fontSet = document.fonts;
    const fontReadyHandler = () => {
      fitAndEmitResize(true);
    };
    fontSet?.addEventListener?.("loadingdone", fontReadyHandler);
    void fontSet?.ready
      .then(() => {
        fitAndEmitResize(true);
      })
      .catch(() => {
        // no-op
      });

    window.setTimeout(() => fitAndEmitResize(true), 0);

    if (outputText.length > 0) {
      terminal.write(outputText);
      renderedOutputRef.current = outputText;
    }

    return () => {
      inputDisposable.dispose();
      resizeObserver.disconnect();
      window.removeEventListener("resize", windowResizeHandler);
      visualViewport?.removeEventListener("resize", visualViewportResizeHandler);
      window.clearInterval(fitInterval);
      for (const handle of fitTimeoutHandles) {
        window.clearTimeout(handle);
      }
      fontSet?.removeEventListener?.("loadingdone", fontReadyHandler);
      root.removeEventListener("touchstart", rootTouchStartHandler);
      root.removeEventListener("touchmove", rootTouchMoveHandler);
      root.removeEventListener("touchend", rootTouchEndHandler);
      root.removeEventListener("touchcancel", rootTouchCancelHandler);

      fitAddon.dispose();
      terminal.dispose();

      documentElement.style.overflow = previousDocumentElementOverflow;
      documentElement.style.width = previousDocumentElementWidth;
      documentElement.style.height = previousDocumentElementHeight;

      body.style.overflow = previousBodyOverflow;
      body.style.width = previousBodyWidth;
      body.style.height = previousBodyHeight;
      body.style.margin = previousBodyMargin;
      body.style.padding = previousBodyPadding;

      if (rootContainer) {
        rootContainer.style.overflow = previousRootOverflow;
        rootContainer.style.width = previousRootWidth;
        rootContainer.style.height = previousRootHeight;
      }

      if (viewportElement) {
        viewportElement.style.overscrollBehavior = previousViewportOverscroll;
        viewportElement.style.touchAction = previousViewportTouchAction;
        viewportElement.style.overflowY = previousViewportOverflowY;
        viewportElement.style.overflowX = previousViewportOverflowX;
        viewportElement.style.pointerEvents = previousViewportPointerEvents;
        viewportElement.style.setProperty(
          "-webkit-overflow-scrolling",
          previousViewportWebkitOverflowScrolling
        );
      }
      if (screenElement) {
        screenElement.style.pointerEvents = previousScreenPointerEvents;
      }

      terminalRef.current = null;
      if (window.__paseoTerminal === terminal) {
        window.__paseoTerminal = undefined;
      }
      renderedOutputRef.current = "";
      lastSizeRef.current = null;
    };
  }, [backgroundColor, cursorColor, foregroundColor, streamKey]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    const previous = renderedOutputRef.current;
    if (outputText === previous) {
      return;
    }

    if (previous.length > 0 && outputText.startsWith(previous)) {
      const suffix = outputText.slice(previous.length);
      if (suffix.length > 0) {
        terminal.write(suffix);
      }
    } else {
      terminal.reset();
      terminal.clear();
      if (outputText.length > 0) {
        terminal.write(outputText);
      }
    }

    renderedOutputRef.current = outputText;
  }, [outputText]);

  useEffect(() => {
    if (focusRequestToken <= 0) {
      return;
    }
    terminalRef.current?.focus();
  }, [focusRequestToken]);

  return (
    <div
      ref={rootRef}
      data-testid={testId}
      style={{
        position: "relative",
        display: "flex",
        width: "100%",
        height: "100%",
        minHeight: 0,
        minWidth: 0,
        backgroundColor,
        overflow: "hidden",
        overscrollBehavior: "none",
      }}
      onPointerDown={() => {
        terminalRef.current?.focus();
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
        }}
      />
    </div>
  );
}
