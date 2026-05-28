import type { ITheme } from "@xterm/xterm";
import xtermCss from "@xterm/xterm/css/xterm.css";
import type { TerminalState } from "@getpaseo/protocol/messages";
import type { TerminalInputModeState } from "@getpaseo/protocol/terminal-input-mode";
import type { PendingTerminalModifiers } from "@/utils/terminal-keys";
import {
  encodeTerminalOutput,
  TerminalEmulatorRuntime,
} from "../runtime/terminal-emulator-runtime";
import type {
  TerminalLocalFileLinkSource,
  TerminalLocalFileLinkTarget,
} from "../local-links/terminal-local-link-provider";

interface MountMessage {
  type: "mount";
  streamKey: string;
  initialSnapshot: TerminalState | null;
  scrollbackLines: number;
  theme: ITheme;
  pendingModifiers: PendingTerminalModifiers;
  swipeGesturesEnabled: boolean;
}

type InboundMessage =
  | MountMessage
  | { type: "unmount"; streamKey: string }
  | { type: "writeOutput"; streamKey: string; text: string }
  | { type: "restoreOutput"; streamKey: string; text: string }
  | { type: "renderSnapshot"; streamKey: string; state: TerminalState | null }
  | { type: "clear"; streamKey: string }
  | { type: "focus"; streamKey: string; forceRefocus?: boolean }
  | { type: "resize"; streamKey: string }
  | { type: "setTheme"; streamKey: string; theme: ITheme }
  | { type: "setScrollback"; streamKey: string; lines: number }
  | { type: "setPendingModifiers"; streamKey: string; pendingModifiers: PendingTerminalModifiers }
  | { type: "setSwipeGesturesEnabled"; streamKey: string; enabled: boolean }
  | {
      type: "resolveLocalFileLinkResponse";
      streamKey: string;
      requestId: number;
      target: TerminalLocalFileLinkTarget | null;
    };

type OutboundMessage =
  | { type: "bridgeReady" }
  | { type: "rendererReady"; streamKey: string; isReady: boolean }
  | { type: "input"; streamKey: string; data: string }
  | { type: "resize"; streamKey: string; rows: number; cols: number }
  | {
      type: "terminalKey";
      streamKey: string;
      key: string;
      ctrl: boolean;
      shift: boolean;
      alt: boolean;
      meta: boolean;
    }
  | { type: "pendingModifiersConsumed"; streamKey: string }
  | { type: "inputModeChange"; streamKey: string; state: TerminalInputModeState }
  | { type: "openExternalUrl"; streamKey: string; url: string }
  | {
      type: "resolveLocalFileLink";
      streamKey: string;
      requestId: number;
      source: TerminalLocalFileLinkSource;
    }
  | {
      type: "openLocalFileLink";
      streamKey: string;
      target: TerminalLocalFileLinkTarget;
      disposition: "main" | "side";
    }
  | { type: "swipeLeft"; streamKey: string }
  | { type: "swipeRight"; streamKey: string }
  | { type: "debug"; message: string; details?: unknown };

declare global {
  interface Window {
    ReactNativeWebView?: {
      postMessage?: (data: string) => void;
    };
    __PASEO_TERMINAL_WEBVIEW_RECEIVE__?: (message: InboundMessage) => void;
    __PASEO_TERMINAL_WEBVIEW_BLUR__?: () => void;
  }
}

const sendToNative = (message: OutboundMessage): void => {
  window.ReactNativeWebView?.postMessage?.(JSON.stringify(message));
};

const TERMINAL_BACKGROUND_CSS_VAR = "--paseo-terminal-background";
const DEFAULT_TERMINAL_BACKGROUND = "#0b0b0b";
const TERMINAL_TAP_MOVE_TOLERANCE_PX = 8;

function getTerminalBackground(theme: ITheme): string {
  return theme.background ?? DEFAULT_TERMINAL_BACKGROUND;
}

const installStyles = (): void => {
  const style = document.createElement("style");
  style.textContent = `
${xtermCss}
:root {
  ${TERMINAL_BACKGROUND_CSS_VAR}: transparent;
}
html,
body,
#terminal-root {
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  overflow: hidden;
  overscroll-behavior: none;
  background: var(${TERMINAL_BACKGROUND_CSS_VAR});
}
#terminal-root {
  display: flex;
  min-width: 0;
  min-height: 0;
}
#terminal-host {
  flex: 1;
  min-width: 0;
  min-height: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(${TERMINAL_BACKGROUND_CSS_VAR});
}
#terminal-root .xterm,
#terminal-root .xterm-screen,
#terminal-root .xterm-viewport {
  background-color: var(${TERMINAL_BACKGROUND_CSS_VAR}) !important;
}
[data-terminal-scrollbar-root="true"] .xterm-viewport {
  scrollbar-width: none;
  -ms-overflow-style: none;
}
[data-terminal-scrollbar-root="true"] .xterm-viewport::-webkit-scrollbar {
  width: 0;
  height: 0;
}
#terminal-root .xterm .xterm-helper-textarea {
  opacity: 0.01;
  width: 1px;
  height: 1px;
  min-width: 1px;
  min-height: 1px;
  color: transparent;
  background: transparent;
  caret-color: transparent;
  z-index: 5 !important;
}
`;
  document.head.appendChild(style);
};

class TerminalWebViewBridge {
  private runtime: TerminalEmulatorRuntime | null = null;
  private streamKey: string | null = null;
  private nextLocalFileLinkRequestId = 1;
  private readonly pendingLocalFileLinkResolutions = new Map<
    number,
    (target: TerminalLocalFileLinkTarget | null) => void
  >();
  private swipeGesturesEnabled = false;
  private trackingSwipe = false;
  private activePointerId: number | null = null;
  private startX = 0;
  private startY = 0;
  private firedSwipe = false;
  private tapTouchIdentifier: number | null = null;
  private tapStartX = 0;
  private tapStartY = 0;
  private tapMoved = false;

  constructor(
    private readonly root: HTMLDivElement,
    private readonly host: HTMLDivElement,
  ) {
    this.root.addEventListener("pointerdown", this.handlePointerDown, { passive: true });
    this.root.addEventListener("touchstart", this.handleTouchStart, { passive: true });
    this.root.addEventListener("touchmove", this.handleTouchMove, { passive: true });
    this.root.addEventListener("touchend", this.handleTouchEnd, { passive: true });
    this.root.addEventListener("touchcancel", this.handleTouchCancel, { passive: true });
    this.root.addEventListener("pointermove", this.handlePointerMove, { passive: false });
    this.root.addEventListener("pointerup", this.handlePointerUp, { passive: true });
    this.root.addEventListener("pointercancel", this.handlePointerUp, { passive: true });
  }

  receive = (message: InboundMessage): void => {
    try {
      this.receiveUnsafe(message);
    } catch (error) {
      sendToNative({
        type: "debug",
        message: "terminal webview receive failed",
        details: error instanceof Error ? { message: error.message, stack: error.stack } : error,
      });
    }
  };

  private receiveUnsafe(message: InboundMessage): void {
    if (message.type === "mount") {
      this.mount(message);
      return;
    }
    if (message.type === "unmount") {
      this.unmount(message.streamKey);
      return;
    }
    if (!this.matches(message.streamKey)) {
      return;
    }
    if (message.type === "resolveLocalFileLinkResponse") {
      this.resolveLocalFileLinkRequest(message.requestId, message.target);
      return;
    }
    this.receiveMounted(message);
  }

  private receiveMounted(
    message: Exclude<
      InboundMessage,
      MountMessage | { type: "unmount" } | { type: "resolveLocalFileLinkResponse" }
    >,
  ): void {
    switch (message.type) {
      case "writeOutput":
        this.runtime?.write({ data: encodeTerminalOutput(message.text) });
        break;
      case "restoreOutput":
        this.runtime?.restoreOutput({ data: encodeTerminalOutput(message.text) });
        break;
      case "renderSnapshot":
        this.runtime?.renderSnapshot({ state: message.state });
        break;
      case "clear":
        this.runtime?.clear();
        break;
      case "focus":
        this.runtime?.focus({ forceRefocus: message.forceRefocus });
        break;
      case "resize":
        this.runtime?.resize({ force: true });
        break;
      case "setTheme":
        this.applyThemeBackground(message.theme);
        this.runtime?.setTheme({ theme: message.theme });
        break;
      case "setScrollback":
        this.runtime?.setScrollback({ lines: message.lines });
        break;
      case "setPendingModifiers":
        this.runtime?.setPendingModifiers({ pendingModifiers: message.pendingModifiers });
        break;
      case "setSwipeGesturesEnabled":
        this.swipeGesturesEnabled = message.enabled;
        break;
    }
  }

  private mount(message: MountMessage): void {
    this.unmount(this.streamKey);
    this.streamKey = message.streamKey;
    this.swipeGesturesEnabled = message.swipeGesturesEnabled;
    this.applyThemeBackground(message.theme);

    const runtime = new TerminalEmulatorRuntime();
    this.runtime = runtime;
    runtime.setCallbacks({
      callbacks: {
        onInput: (data) => sendToNative({ type: "input", streamKey: message.streamKey, data }),
        onResize: ({ rows, cols }) =>
          sendToNative({ type: "resize", streamKey: message.streamKey, rows, cols }),
        onTerminalKey: (input) =>
          sendToNative({ type: "terminalKey", streamKey: message.streamKey, ...input }),
        onPendingModifiersConsumed: () =>
          sendToNative({ type: "pendingModifiersConsumed", streamKey: message.streamKey }),
        onInputModeChange: (state) =>
          sendToNative({ type: "inputModeChange", streamKey: message.streamKey, state }),
        onOpenExternalUrl: (url) =>
          sendToNative({ type: "openExternalUrl", streamKey: message.streamKey, url }),
        onResolveLocalFileLink: (source) => this.requestLocalFileLinkResolution(source),
        onOpenLocalFileLink: (target, disposition) =>
          sendToNative({
            type: "openLocalFileLink",
            streamKey: message.streamKey,
            target,
            disposition,
          }),
      },
    });
    runtime.setPendingModifiers({ pendingModifiers: message.pendingModifiers });
    runtime.mount({
      root: this.root,
      host: this.host,
      initialSnapshot: message.initialSnapshot,
      scrollback: message.scrollbackLines,
      theme: message.theme,
    });
    sendToNative({ type: "rendererReady", streamKey: message.streamKey, isReady: true });
  }

  private applyThemeBackground(theme: ITheme): void {
    const background = getTerminalBackground(theme);
    document.documentElement.style.setProperty(TERMINAL_BACKGROUND_CSS_VAR, background);
    document.body.style.backgroundColor = background;
    this.root.style.backgroundColor = background;
    this.host.style.backgroundColor = background;
  }

  blur = (): void => {
    this.runtime?.blur();
  };

  private unmount(streamKey: string | null): void {
    if (!this.runtime) {
      return;
    }
    const previousStreamKey = this.streamKey;
    this.runtime.unmount();
    this.runtime = null;
    this.streamKey = null;
    this.resolveAllLocalFileLinkRequests(null);
    if (previousStreamKey && (!streamKey || streamKey === previousStreamKey)) {
      sendToNative({ type: "rendererReady", streamKey: previousStreamKey, isReady: false });
    }
  }

  private matches(streamKey: string): boolean {
    return this.streamKey === streamKey;
  }

  private requestLocalFileLinkResolution(
    source: TerminalLocalFileLinkSource,
  ): Promise<TerminalLocalFileLinkTarget | null> {
    const streamKey = this.streamKey;
    if (!streamKey) {
      return Promise.resolve(null);
    }

    const requestId = this.nextLocalFileLinkRequestId++;
    return new Promise((resolve) => {
      this.pendingLocalFileLinkResolutions.set(requestId, resolve);
      sendToNative({
        type: "resolveLocalFileLink",
        streamKey,
        requestId,
        source,
      });
    });
  }

  private resolveLocalFileLinkRequest(
    requestId: number,
    target: TerminalLocalFileLinkTarget | null,
  ): void {
    const resolve = this.pendingLocalFileLinkResolutions.get(requestId);
    if (!resolve) {
      return;
    }
    this.pendingLocalFileLinkResolutions.delete(requestId);
    resolve(target);
  }

  private resolveAllLocalFileLinkRequests(target: TerminalLocalFileLinkTarget | null): void {
    const requests = Array.from(this.pendingLocalFileLinkResolutions.values());
    this.pendingLocalFileLinkResolutions.clear();
    for (const resolve of requests) {
      resolve(target);
    }
  }

  private handlePointerDown = (event: PointerEvent): void => {
    if (!event.isPrimary) {
      return;
    }
    if (!this.swipeGesturesEnabled) {
      return;
    }
    this.trackingSwipe = true;
    this.firedSwipe = false;
    this.activePointerId = event.pointerId;
    this.startX = event.clientX;
    this.startY = event.clientY;
  };

  private handleTouchStart = (event: TouchEvent): void => {
    if (event.touches.length !== 1) {
      this.resetTap();
      return;
    }
    const touch = event.touches[0];
    this.tapTouchIdentifier = touch.identifier;
    this.tapStartX = touch.clientX;
    this.tapStartY = touch.clientY;
    this.tapMoved = false;
  };

  private handleTouchMove = (event: TouchEvent): void => {
    const touch = this.findTrackedTouch(event.touches);
    if (!touch) {
      return;
    }
    const dx = touch.clientX - this.tapStartX;
    const dy = touch.clientY - this.tapStartY;
    if (
      Math.abs(dx) > TERMINAL_TAP_MOVE_TOLERANCE_PX ||
      Math.abs(dy) > TERMINAL_TAP_MOVE_TOLERANCE_PX
    ) {
      this.tapMoved = true;
    }
  };

  private handleTouchEnd = (event: TouchEvent): void => {
    const completedTap = Boolean(this.findTrackedTouch(event.changedTouches) && !this.tapMoved);
    this.resetTap();
    if (completedTap) {
      this.runtime?.focus({ forceRefocus: true });
    }
  };

  private handleTouchCancel = (): void => {
    this.resetTap();
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (!this.trackingSwipe || this.firedSwipe || !this.streamKey) {
      return;
    }
    if (this.activePointerId !== null && event.pointerId !== this.activePointerId) {
      return;
    }

    const dx = event.clientX - this.startX;
    const dy = event.clientY - this.startY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    if (absDy >= 12 && absDy > absDx) {
      this.resetSwipe();
      return;
    }
    if (absDx < 22 || (absDy !== 0 && absDx / absDy < 1.2)) {
      return;
    }

    this.firedSwipe = true;
    sendToNative({ type: dx > 0 ? "swipeRight" : "swipeLeft", streamKey: this.streamKey });
    if (event.cancelable) event.preventDefault();
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (this.activePointerId !== null && event.pointerId !== this.activePointerId) {
      return;
    }
    this.resetSwipe();
  };

  private resetSwipe(): void {
    this.trackingSwipe = false;
    this.activePointerId = null;
    this.startX = 0;
    this.startY = 0;
    this.firedSwipe = false;
  }

  private findTrackedTouch(touches: TouchList): Touch | null {
    if (this.tapTouchIdentifier === null) {
      return null;
    }
    for (let index = 0; index < touches.length; index += 1) {
      const touch = touches.item(index);
      if (touch?.identifier === this.tapTouchIdentifier) {
        return touch;
      }
    }
    return null;
  }

  private resetTap(): void {
    this.tapTouchIdentifier = null;
    this.tapStartX = 0;
    this.tapStartY = 0;
    this.tapMoved = false;
  }
}

installStyles();

const root = document.createElement("div");
root.id = "terminal-root";
root.dataset.terminalScrollbarRoot = "true";
const host = document.createElement("div");
host.id = "terminal-host";
root.appendChild(host);
document.body.appendChild(root);

const bridge = new TerminalWebViewBridge(root, host);
window.__PASEO_TERMINAL_WEBVIEW_RECEIVE__ = bridge.receive;
window.__PASEO_TERMINAL_WEBVIEW_BLUR__ = bridge.blur;
sendToNative({ type: "bridgeReady" });
