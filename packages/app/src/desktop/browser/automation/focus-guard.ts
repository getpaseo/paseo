import { getIsElectron } from "@/constants/platform";
import { getDesktopHost } from "@/desktop/host";
import { getResidentBrowserWebview } from "@/desktop/browser/resident-webviews";

// Main brackets agent CDP pointer presses (browser_click, browser_drag) because
// Chromium moves window focus into the guest on mousePressed even with focus
// emulation enabled. Restore the user's host element afterward and refuse presses
// while an IME composition is active so unfinished text is never committed.

const LATE_FOCUS_RECHECK_MS = 50;
const ABANDONED_GUARD_MS = 30_000;

interface BrowserFocusGuardEvent {
  browserId: string;
  token: string;
  active: boolean;
}

const releasesByToken = new Map<string, () => void>();
const inFlightByBrowserId = new Map<string, number>();
const pendingRecheckTimers = new Set<ReturnType<typeof setTimeout>>();

let composingElement: EventTarget | null = null;
let inFlight = 0;
let userElement: Element | null = null;
let bridgeInstalled = false;

function decrementBrowserInFlight(browserId: string): void {
  const remaining = (inFlightByBrowserId.get(browserId) ?? 0) - 1;
  if (remaining <= 0) {
    inFlightByBrowserId.delete(browserId);
  } else {
    inFlightByBrowserId.set(browserId, remaining);
  }
}

function settle(browserId: string): void {
  decrementBrowserInFlight(browserId);
  inFlight = Math.max(0, inFlight - 1);
  if (inFlight === 0) {
    userElement = null;
  }
}

function isUserComposing(): boolean {
  return (
    typeof document !== "undefined" &&
    composingElement !== null &&
    composingElement === document.activeElement
  );
}

export function isAgentInputMovingFocus(browserId?: string): boolean {
  if (browserId !== undefined) {
    return (inFlightByBrowserId.get(browserId) ?? 0) > 0;
  }
  return inFlight > 0;
}

export function watchUserComposition(): () => void {
  if (typeof document === "undefined") {
    return () => {};
  }
  const onStart = (event: Event): void => {
    composingElement = event.target;
  };
  // Nonempty updates can start composition without compositionstart; empty updates
  // from IMEs such as Sogou/fcitx must not clear an open candidate session.
  const onUpdate = (event: Event): void => {
    const data = "data" in event ? (event as { data?: unknown }).data : undefined;
    if (typeof data === "string" && data !== "") {
      composingElement = event.target;
    }
  };
  const onEnd = (): void => {
    composingElement = null;
  };
  // Non-composing input clears missed compositionend events while preserving
  // composition-owned edits (e.g. Cangjie Backspace).
  const onInput = (event: Event): void => {
    const composing =
      "isComposing" in event ? (event as { isComposing?: unknown }).isComposing === true : false;
    if (!composing) {
      composingElement = null;
    }
  };
  const listeners: Array<[string, (event: Event) => void]> = [
    ["compositionstart", onStart],
    ["compositionupdate", onUpdate],
    ["compositionend", onEnd],
    ["input", onInput],
  ];
  for (const [type, listener] of listeners) {
    document.addEventListener(type, listener, true);
  }
  return () => {
    for (const [type, listener] of listeners) {
      document.removeEventListener(type, listener, true);
    }
    composingElement = null;
  };
}

export function beginAgentInputFocusGuard(
  browserId: string,
  token: string,
  lookupWebview: (id: string) => HTMLElement | null = getResidentBrowserWebview,
): "ready" | "composing" {
  if (isUserComposing()) {
    return "composing";
  }
  if (typeof document === "undefined") {
    return "ready";
  }
  const webview = lookupWebview(browserId);
  if (!webview) {
    return "ready";
  }
  const active = document.activeElement;
  if (inFlight === 0) {
    // A user already focused in this browser page keeps focus there.
    if (active === webview) {
      return "ready";
    }
    userElement = active;
  } else if (
    active instanceof HTMLElement &&
    active !== document.body &&
    active.tagName !== "WEBVIEW"
  ) {
    // Keep the earlier host element when activeElement belongs to an agent-focused
    // webview or document.body, but follow if the user moved to another host control.
    userElement = active;
  }

  inFlight += 1;
  inFlightByBrowserId.set(browserId, (inFlightByBrowserId.get(browserId) ?? 0) + 1);

  const restore = (): void => {
    const previous = userElement;
    const current = document.activeElement;
    const focusWasTaken =
      current === webview ||
      (current === document.body && previous !== null && previous !== document.body) ||
      (current === null && previous !== null);
    if (!focusWasTaken) {
      return;
    }
    if (previous instanceof HTMLElement && previous !== document.body && previous.isConnected) {
      previous.focus({ preventScroll: true });
    } else if (current === webview && typeof webview.blur === "function") {
      webview.blur();
    }
  };

  const abandoned = setTimeout(() => endAgentInputFocusGuard(token), ABANDONED_GUARD_MS);
  releasesByToken.set(token, () => {
    clearTimeout(abandoned);
    restore();
    const recheck = setTimeout(() => {
      pendingRecheckTimers.delete(recheck);
      restore();
      settle(browserId);
    }, LATE_FOCUS_RECHECK_MS);
    pendingRecheckTimers.add(recheck);
  });
  return "ready";
}

export function endAgentInputFocusGuard(token: string): void {
  const release = releasesByToken.get(token);
  releasesByToken.delete(token);
  release?.();
}

export function clearAgentInputFocusGuards(): void {
  for (const release of releasesByToken.values()) {
    release();
  }
  releasesByToken.clear();
  for (const timer of pendingRecheckTimers) {
    clearTimeout(timer);
  }
  pendingRecheckTimers.clear();
  inFlightByBrowserId.clear();
  inFlight = 0;
  userElement = null;
  composingElement = null;
}

function isBrowserFocusGuardEvent(value: unknown): value is BrowserFocusGuardEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.browserId === "string" &&
    typeof record.token === "string" &&
    typeof record.active === "boolean"
  );
}

export function installBrowserFocusGuardBridge(): void {
  if (bridgeInstalled || !getIsElectron()) {
    return;
  }
  const desktop = getDesktopHost();
  const acknowledge = desktop?.browser?.acknowledgeFocusGuard;
  if (!desktop?.events?.on || typeof acknowledge !== "function") {
    return;
  }
  bridgeInstalled = true;
  watchUserComposition();
  void desktop.events.on("browser-focus-guard", (payload) => {
    if (!isBrowserFocusGuardEvent(payload)) {
      return;
    }
    if (payload.active) {
      const outcome = beginAgentInputFocusGuard(payload.browserId, payload.token);
      acknowledge({ token: payload.token, composing: outcome === "composing" });
    } else {
      endAgentInputFocusGuard(payload.token);
    }
  });
}
