import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  type PendingTerminalModifiers,
  isTerminalModifierDomKey,
  mergeTerminalModifiers,
  normalizeDomTerminalKey,
  normalizeTerminalTransportKey,
  shouldInterceptDomTerminalKey,
} from "@/utils/terminal-keys";

export type TerminalEmulatorRuntimeTheme = {
  backgroundColor: string;
  foregroundColor: string;
  cursorColor: string;
};

export type TerminalEmulatorRuntimeMountInput = {
  root: HTMLDivElement;
  host: HTMLDivElement;
  initialOutputText: string;
  theme: TerminalEmulatorRuntimeTheme;
};

export type TerminalEmulatorRuntimeCallbacks = {
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
};

type TerminalEmulatorRuntimeDisposables = {
  disposeInput: () => void;
  disconnectResizeObserver: () => void;
  removeWindowResize: () => void;
  removeVisualViewportResize: () => void;
  clearFitInterval: () => void;
  clearFitTimeouts: () => void;
  removeFontListeners: () => void;
  removeTouchListeners: () => void;
  restoreDocumentStyles: () => void;
  restoreViewportStyles: () => void;
  disposeFitAddon: () => void;
  disposeTerminal: () => void;
};

declare global {
  interface Window {
    __paseoTerminal?: Terminal;
  }
}

const DEFAULT_TOUCH_SCROLL_LINE_HEIGHT_PX = 18;
const FIT_TIMEOUT_DELAYS_MS = [0, 16, 48, 120, 250, 500, 1_000, 2_000];

export class TerminalEmulatorRuntime {
  private callbacks: TerminalEmulatorRuntimeCallbacks = {};
  private pendingModifiers: PendingTerminalModifiers = {
    ctrl: false,
    shift: false,
    alt: false,
  };
  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private lastSize: { rows: number; cols: number } | null = null;
  private cleanup: (() => void) | null = null;
  private pendingWriteText = "";
  private isWriteFlushQueued = false;

  setCallbacks(input: { callbacks: TerminalEmulatorRuntimeCallbacks }): void {
    this.callbacks = input.callbacks;
  }

  setPendingModifiers(input: { pendingModifiers: PendingTerminalModifiers }): void {
    this.pendingModifiers = input.pendingModifiers;
  }

  mount(input: TerminalEmulatorRuntimeMountInput): void {
    this.unmount();

    input.host.innerHTML = "";
    this.lastSize = null;

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
        background: input.theme.backgroundColor,
        foreground: input.theme.foregroundColor,
        cursor: input.theme.cursorColor,
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(input.host);

    const restoreDocumentStyles = this.applyDocumentBoundsStyles({
      root: input.root,
    });
    const restoreViewportStyles = this.applyViewportTouchStyles({
      host: input.host,
    });

    this.terminal = terminal;
    this.fitAddon = fitAddon;
    window.__paseoTerminal = terminal;

    const fitAndEmitResize = (force: boolean): void => {
      const currentTerminal = this.terminal;
      const currentFitAddon = this.fitAddon;
      if (!currentTerminal || !currentFitAddon) {
        return;
      }

      try {
        currentFitAddon.fit();
      } catch {
        return;
      }

      const nextRows = currentTerminal.rows;
      const nextCols = currentTerminal.cols;
      const previous = this.lastSize;
      if (!force && previous && previous.rows === nextRows && previous.cols === nextCols) {
        return;
      }

      this.lastSize = { rows: nextRows, cols: nextCols };
      this.callbacks.onResize?.({
        rows: nextRows,
        cols: nextCols,
      });
    };

    fitAndEmitResize(true);

    const inputDisposable = terminal.onData((data) => {
      this.callbacks.onInput?.(data);
    });

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || event.isComposing) {
        return true;
      }

      const normalizedKey = normalizeDomTerminalKey(event.key);
      if (!normalizedKey || isTerminalModifierDomKey(event.key)) {
        return true;
      }

      if (
        !shouldInterceptDomTerminalKey({
          key: normalizedKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          pendingModifiers: this.pendingModifiers,
        })
      ) {
        return true;
      }

      const modifiers = mergeTerminalModifiers({
        pendingModifiers: this.pendingModifiers,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
      });
      this.callbacks.onTerminalKey?.({
        key: normalizeTerminalTransportKey(normalizedKey),
        ...modifiers,
      });

      if (this.pendingModifiers.ctrl || this.pendingModifiers.shift || this.pendingModifiers.alt) {
        this.callbacks.onPendingModifiersConsumed?.();
      }

      event.preventDefault();
      event.stopPropagation();
      return false;
    });

    const removeTouchListeners = this.setupTouchScrollHandlers({
      root: input.root,
      host: input.host,
      terminal,
    });
    const resizeObserver = new ResizeObserver(() => {
      fitAndEmitResize(false);
    });
    resizeObserver.observe(input.root);
    resizeObserver.observe(input.host);

    const windowResizeHandler = () => fitAndEmitResize(false);
    window.addEventListener("resize", windowResizeHandler);

    const visualViewport = window.visualViewport;
    const visualViewportResizeHandler = () => fitAndEmitResize(false);
    visualViewport?.addEventListener("resize", visualViewportResizeHandler);

    const fitInterval = window.setInterval(() => {
      fitAndEmitResize(false);
    }, 250);
    const fitTimeouts = FIT_TIMEOUT_DELAYS_MS.map((delayMs) =>
      window.setTimeout(() => {
        fitAndEmitResize(true);
      }, delayMs)
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

    window.setTimeout(() => {
      fitAndEmitResize(true);
    }, 0);

    if (input.initialOutputText.length > 0) {
      terminal.write(input.initialOutputText);
    }

    const disposables: TerminalEmulatorRuntimeDisposables = {
      disposeInput: () => {
        inputDisposable.dispose();
      },
      disconnectResizeObserver: () => {
        resizeObserver.disconnect();
      },
      removeWindowResize: () => {
        window.removeEventListener("resize", windowResizeHandler);
      },
      removeVisualViewportResize: () => {
        visualViewport?.removeEventListener("resize", visualViewportResizeHandler);
      },
      clearFitInterval: () => {
        window.clearInterval(fitInterval);
      },
      clearFitTimeouts: () => {
        for (const handle of fitTimeouts) {
          window.clearTimeout(handle);
        }
      },
      removeFontListeners: () => {
        fontSet?.removeEventListener?.("loadingdone", fontReadyHandler);
      },
      removeTouchListeners,
      restoreDocumentStyles,
      restoreViewportStyles,
      disposeFitAddon: () => {
        fitAddon.dispose();
      },
      disposeTerminal: () => {
        terminal.dispose();
      },
    };

    this.cleanup = () => {
      disposables.disposeInput();
      disposables.disconnectResizeObserver();
      disposables.removeWindowResize();
      disposables.removeVisualViewportResize();
      disposables.clearFitInterval();
      disposables.clearFitTimeouts();
      disposables.removeFontListeners();
      disposables.removeTouchListeners();
      disposables.disposeFitAddon();
      disposables.disposeTerminal();
      disposables.restoreDocumentStyles();
      disposables.restoreViewportStyles();
    };
  }

  write(input: { text: string }): void {
    if (!this.terminal || input.text.length === 0) {
      return;
    }
    this.pendingWriteText += input.text;
    this.scheduleWriteFlush();
  }

  clear(): void {
    this.pendingWriteText = "";
    this.terminal?.reset();
  }

  focus(): void {
    this.terminal?.focus();
  }

  unmount(): void {
    this.pendingWriteText = "";
    this.isWriteFlushQueued = false;

    this.cleanup?.();
    this.cleanup = null;
    if (window.__paseoTerminal === this.terminal) {
      window.__paseoTerminal = undefined;
    }
    this.terminal = null;
    this.fitAddon = null;
    this.lastSize = null;
  }

  private scheduleWriteFlush(): void {
    if (this.isWriteFlushQueued) {
      return;
    }

    this.isWriteFlushQueued = true;
    queueMicrotask(() => {
      this.isWriteFlushQueued = false;
      this.flushWriteQueue();
    });
  }

  private flushWriteQueue(): void {
    if (!this.terminal || this.pendingWriteText.length === 0) {
      return;
    }
    const text = this.pendingWriteText;
    this.pendingWriteText = "";
    this.terminal.write(text);
  }

  private applyDocumentBoundsStyles(input: { root: HTMLDivElement }): () => void {
    const documentElement = document.documentElement;
    const body = document.body;
    const rootContainer = input.root.parentElement;

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

    return () => {
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
    };
  }

  private applyViewportTouchStyles(input: { host: HTMLDivElement }): () => void {
    const viewportElement = input.host.querySelector<HTMLElement>(".xterm-viewport");
    const screenElement = input.host.querySelector<HTMLElement>(".xterm-screen");

    const previousViewportOverscroll = viewportElement?.style.overscrollBehavior ?? "";
    const previousViewportTouchAction = viewportElement?.style.touchAction ?? "";
    const previousViewportOverflowY = viewportElement?.style.overflowY ?? "";
    const previousViewportOverflowX = viewportElement?.style.overflowX ?? "";
    const previousViewportPointerEvents = viewportElement?.style.pointerEvents ?? "";
    const previousViewportWebkitOverflowScrolling =
      viewportElement?.style.getPropertyValue("-webkit-overflow-scrolling") ?? "";
    const previousScreenPointerEvents = screenElement?.style.pointerEvents ?? "";

    if (viewportElement) {
      viewportElement.style.overscrollBehavior = "none";
      viewportElement.style.touchAction = "pan-y";
      viewportElement.style.overflowY = "auto";
      viewportElement.style.overflowX = "hidden";
      viewportElement.style.pointerEvents = "auto";
      viewportElement.style.setProperty("-webkit-overflow-scrolling", "touch");
    }
    if (screenElement) {
      screenElement.style.pointerEvents = "none";
    }

    return () => {
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
    };
  }

  private setupTouchScrollHandlers(input: {
    root: HTMLDivElement;
    host: HTMLDivElement;
    terminal: Terminal;
  }): () => void {
    let touchScrollRemainderPx = 0;
    const measuredLineHeight =
      input.host.querySelector<HTMLElement>(".xterm-rows > div")?.getBoundingClientRect()
        .height ?? 0;
    const touchScrollLineHeightPx =
      measuredLineHeight > 0
        ? measuredLineHeight
        : DEFAULT_TOUCH_SCROLL_LINE_HEIGHT_PX;

    const activeTouch = {
      identifier: -1,
      startX: 0,
      startY: 0,
      lastX: 0,
      lastY: 0,
      mode: null as "vertical" | "horizontal" | null,
    };

    const touchStartHandler = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        touchScrollRemainderPx = 0;
        activeTouch.identifier = -1;
        activeTouch.mode = null;
        return;
      }

      const touch = event.touches[0];
      if (!touch) {
        touchScrollRemainderPx = 0;
        activeTouch.identifier = -1;
        activeTouch.mode = null;
        return;
      }

      activeTouch.identifier = touch.identifier;
      activeTouch.startX = touch.clientX;
      activeTouch.startY = touch.clientY;
      activeTouch.lastX = touch.clientX;
      activeTouch.lastY = touch.clientY;
      activeTouch.mode = null;
      touchScrollRemainderPx = 0;
    };

    const touchMoveHandler = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        return;
      }

      const touch = Array.from(event.touches).find(
        (candidate) => candidate.identifier === activeTouch.identifier
      );
      if (!touch) {
        return;
      }

      const totalDeltaX = touch.clientX - activeTouch.startX;
      const totalDeltaY = touch.clientY - activeTouch.startY;
      if (activeTouch.mode === null) {
        const absX = Math.abs(totalDeltaX);
        const absY = Math.abs(totalDeltaY);
        if (absX > 8 || absY > 8) {
          activeTouch.mode = absY >= absX ? "vertical" : "horizontal";
        }
      }

      const deltaY = touch.clientY - activeTouch.lastY;
      activeTouch.lastX = touch.clientX;
      activeTouch.lastY = touch.clientY;

      if (activeTouch.mode !== "vertical") {
        return;
      }

      touchScrollRemainderPx += deltaY;
      const lineDelta = Math.trunc(touchScrollRemainderPx / touchScrollLineHeightPx);
      if (lineDelta !== 0) {
        input.terminal.scrollLines(-lineDelta);
        touchScrollRemainderPx -= lineDelta * touchScrollLineHeightPx;
      }

      event.preventDefault();
    };

    const touchEndHandler = (event: TouchEvent) => {
      const activeTouchEnded = Array.from(event.changedTouches).some(
        (touch) => touch.identifier === activeTouch.identifier
      );
      if (activeTouchEnded || event.touches.length === 0) {
        touchScrollRemainderPx = 0;
        activeTouch.identifier = -1;
        activeTouch.mode = null;
      }
    };

    const touchCancelHandler = () => {
      touchScrollRemainderPx = 0;
      activeTouch.identifier = -1;
      activeTouch.mode = null;
    };

    input.root.addEventListener("touchstart", touchStartHandler, { passive: true });
    input.root.addEventListener("touchmove", touchMoveHandler, { passive: false });
    input.root.addEventListener("touchend", touchEndHandler, { passive: true });
    input.root.addEventListener("touchcancel", touchCancelHandler, { passive: true });

    return () => {
      input.root.removeEventListener("touchstart", touchStartHandler);
      input.root.removeEventListener("touchmove", touchMoveHandler);
      input.root.removeEventListener("touchend", touchEndHandler);
      input.root.removeEventListener("touchcancel", touchCancelHandler);
    };
  }
}
