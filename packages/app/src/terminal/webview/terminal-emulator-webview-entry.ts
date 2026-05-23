import type { ITheme } from "@xterm/xterm";
import xtermCss from "@xterm/xterm/css/xterm.css";
import type { TerminalState } from "@server/shared/messages";
import type { TerminalInputModeState } from "@server/shared/terminal-input-mode";
import type { PendingTerminalModifiers } from "@/utils/terminal-keys";
import {
  encodeTerminalOutput,
  TerminalEmulatorRuntime,
} from "../runtime/terminal-emulator-runtime";

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
  | { type: "focus"; streamKey: string }
  | { type: "resize"; streamKey: string }
  | { type: "setTheme"; streamKey: string; theme: ITheme }
  | { type: "setScrollback"; streamKey: string; lines: number }
  | { type: "setPendingModifiers"; streamKey: string; pendingModifiers: PendingTerminalModifiers }
  | { type: "setSwipeGesturesEnabled"; streamKey: string; enabled: boolean };

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
  | { type: "swipeLeft"; streamKey: string }
  | { type: "swipeRight"; streamKey: string }
  | { type: "debug"; message: string; details?: unknown };

declare global {
  interface Window {
    ReactNativeWebView?: {
      postMessage?: (data: string) => void;
    };
    __PASEO_TERMINAL_WEBVIEW_RECEIVE__?: (message: InboundMessage) => void;
  }
}

const sendToNative = (message: OutboundMessage): void => {
  window.ReactNativeWebView?.postMessage?.(JSON.stringify(message));
};

const installStyles = (): void => {
  const style = document.createElement("style");
  style.textContent = `
${xtermCss}
html,
body,
#terminal-root {
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  overflow: hidden;
  overscroll-behavior: none;
  background: #0b0b0b;
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
}
[data-terminal-scrollbar-root="true"] .xterm-viewport {
  scrollbar-width: none;
  -ms-overflow-style: none;
}
[data-terminal-scrollbar-root="true"] .xterm-viewport::-webkit-scrollbar {
  width: 0;
  height: 0;
}
`;
  document.head.appendChild(style);
};

class TerminalWebViewBridge {
  private runtime: TerminalEmulatorRuntime | null = null;
  private streamKey: string | null = null;
  private swipeGesturesEnabled = false;
  private trackingSwipe = false;
  private activePointerId: number | null = null;
  private startX = 0;
  private startY = 0;
  private firedSwipe = false;

  constructor(
    private readonly root: HTMLDivElement,
    private readonly host: HTMLDivElement,
  ) {
    this.root.addEventListener("pointerdown", this.handlePointerDown, { passive: true });
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
    this.receiveMounted(message);
  }

  private receiveMounted(
    message: Exclude<InboundMessage, MountMessage | { type: "unmount" }>,
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
        this.runtime?.focus();
        break;
      case "resize":
        this.runtime?.resize({ force: true });
        break;
      case "setTheme":
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
    document.body.style.backgroundColor = message.theme.background ?? "#0b0b0b";

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

  private unmount(streamKey: string | null): void {
    if (!this.runtime) {
      return;
    }
    const previousStreamKey = this.streamKey;
    this.runtime.unmount();
    this.runtime = null;
    this.streamKey = null;
    if (previousStreamKey && (!streamKey || streamKey === previousStreamKey)) {
      sendToNative({ type: "rendererReady", streamKey: previousStreamKey, isReady: false });
    }
  }

  private matches(streamKey: string): boolean {
    return this.streamKey === streamKey;
  }

  private handlePointerDown = (event: PointerEvent): void => {
    if (!this.swipeGesturesEnabled || !event.isPrimary) {
      return;
    }
    this.trackingSwipe = true;
    this.firedSwipe = false;
    this.activePointerId = event.pointerId;
    this.startX = event.clientX;
    this.startY = event.clientY;
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
sendToNative({ type: "bridgeReady" });
