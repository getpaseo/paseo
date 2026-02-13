"use dom";

import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { DOMProps } from "expo/dom";
import "@xterm/xterm/css/xterm.css";

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
}

declare global {
  interface Window {
    __paseoTerminal?: Terminal;
  }
}

function isTerminalDebugEnabled(): boolean {
  const explicit = (
    globalThis as {
      __PASEO_TERMINAL_DEBUG?: unknown;
    }
  ).__PASEO_TERMINAL_DEBUG;
  if (typeof explicit === "boolean") {
    return explicit;
  }
  const devFlag = (globalThis as { __DEV__?: unknown }).__DEV__;
  return devFlag === true;
}

function logTerminalDebug(message: string, payload?: Record<string, unknown>): void {
  if (!isTerminalDebugEnabled()) {
    return;
  }
  if (payload) {
    console.log(`[TerminalDebug][DOM] ${message}`, payload);
    return;
  }
  console.log(`[TerminalDebug][DOM] ${message}`);
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
}: TerminalEmulatorProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const renderedOutputRef = useRef("");
  const lastSizeRef = useRef<{ rows: number; cols: number } | null>(null);
  const onInputRef = useRef<TerminalEmulatorProps["onInput"]>(onInput);
  const onResizeRef = useRef<TerminalEmulatorProps["onResize"]>(onResize);

  useEffect(() => {
    onInputRef.current = onInput;
  }, [onInput]);

  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);

  useEffect(() => {
    const host = hostRef.current;
    const root = rootRef.current;
    if (!host || !root) {
      return;
    }

    logTerminalDebug("mount", {
      streamKey,
      hasOnInput: Boolean(onInputRef.current),
      hasOnResize: Boolean(onResizeRef.current),
    });

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
    const previousViewportOverscroll = viewportElement?.style.overscrollBehavior ?? "";
    const previousViewportTouchAction = viewportElement?.style.touchAction ?? "";
    const previousViewportOverflowY = viewportElement?.style.overflowY ?? "";
    const previousViewportOverflowX = viewportElement?.style.overflowX ?? "";
    const previousViewportPointerEvents = viewportElement?.style.pointerEvents ?? "";
    const previousViewportWebkitOverflowScrolling =
      viewportElement?.style.getPropertyValue("-webkit-overflow-scrolling") ?? "";
    if (viewportElement) {
      viewportElement.style.overscrollBehavior = "contain";
      viewportElement.style.touchAction = "pan-y";
      viewportElement.style.overflowY = "auto";
      viewportElement.style.overflowX = "hidden";
      viewportElement.style.pointerEvents = "auto";
      viewportElement.style.setProperty("-webkit-overflow-scrolling", "touch");
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
        logTerminalDebug("fit failed");
        return;
      }

      const rows = terminal.rows;
      const cols = terminal.cols;
      const previous = lastSizeRef.current;
      if (!force && previous && previous.rows === rows && previous.cols === cols) {
        return;
      }

      lastSizeRef.current = { rows, cols };
      const rootRect = root.getBoundingClientRect();
      logTerminalDebug("fit+resize", {
        force,
        rows,
        cols,
        rootWidth: Math.round(rootRect.width),
        rootHeight: Math.round(rootRect.height),
      });
      void handler(rows, cols);
    };

    fitAndEmitResize(true);

    const inputDisposable = terminal.onData((data) => {
      const handler = onInputRef.current;
      if (!handler) {
        return;
      }
      logTerminalDebug("input", {
        length: data.length,
        preview: data.slice(0, 20),
      });
      void handler(data);
    });

    let lastScrollLogTs = 0;
    let lastWheelLogTs = 0;
    let lastTouchMoveLogTs = 0;

    const viewportScrollHandler = () => {
      const now = Date.now();
      if (now - lastScrollLogTs < 120) {
        return;
      }
      lastScrollLogTs = now;
      logTerminalDebug("viewport scroll", {
        baseY: terminal.buffer.active.baseY,
        viewportY: terminal.buffer.active.viewportY,
      });
    };
    const viewportWheelHandler = (event: WheelEvent) => {
      const now = Date.now();
      if (now - lastWheelLogTs < 120) {
        return;
      }
      lastWheelLogTs = now;
      logTerminalDebug("viewport wheel", {
        deltaY: event.deltaY,
        deltaX: event.deltaX,
      });
    };
    const viewportTouchStartHandler = (event: TouchEvent) => {
      logTerminalDebug("viewport touchstart", {
        touches: event.touches.length,
      });
    };
    const viewportTouchMoveHandler = (event: TouchEvent) => {
      const now = Date.now();
      if (now - lastTouchMoveLogTs < 120) {
        return;
      }
      lastTouchMoveLogTs = now;
      logTerminalDebug("viewport touchmove", {
        touches: event.touches.length,
      });
    };

    viewportElement?.addEventListener("scroll", viewportScrollHandler, { passive: true });
    viewportElement?.addEventListener("wheel", viewportWheelHandler, { passive: true });
    viewportElement?.addEventListener("touchstart", viewportTouchStartHandler, {
      passive: true,
    });
    viewportElement?.addEventListener("touchmove", viewportTouchMoveHandler, {
      passive: true,
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAndEmitResize();
    });
    resizeObserver.observe(root);

    const windowResizeHandler = () => fitAndEmitResize();
    window.addEventListener("resize", windowResizeHandler);

    const visualViewport = window.visualViewport;
    const visualViewportResizeHandler = () => fitAndEmitResize();
    visualViewport?.addEventListener("resize", visualViewportResizeHandler);

    // Safety net for keyboard/layout transitions that can skip callbacks.
    const fitInterval = window.setInterval(() => {
      fitAndEmitResize();
    }, 250);

    window.setTimeout(() => fitAndEmitResize(true), 0);

    if (outputText.length > 0) {
      terminal.write(outputText);
      renderedOutputRef.current = outputText;
    }
    terminal.focus();

    return () => {
      inputDisposable.dispose();
      resizeObserver.disconnect();
      window.removeEventListener("resize", windowResizeHandler);
      visualViewport?.removeEventListener("resize", visualViewportResizeHandler);
      window.clearInterval(fitInterval);
      viewportElement?.removeEventListener("scroll", viewportScrollHandler);
      viewportElement?.removeEventListener("wheel", viewportWheelHandler);
      viewportElement?.removeEventListener("touchstart", viewportTouchStartHandler);
      viewportElement?.removeEventListener("touchmove", viewportTouchMoveHandler);

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

      terminalRef.current = null;
      if (window.__paseoTerminal === terminal) {
        window.__paseoTerminal = undefined;
      }
      logTerminalDebug("unmount", { streamKey });
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

  return (
    <div
      ref={rootRef}
      data-testid={testId}
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        display: "flex",
        minHeight: 0,
        minWidth: 0,
        backgroundColor,
        overflow: "hidden",
        overscrollBehavior: "none",
      }}
      onPointerDown={() => {
        logTerminalDebug("root pointerdown", { streamKey });
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
