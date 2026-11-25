import type { RouteLeaveGuard } from "./index";

export type { RouteLeaveGuard } from "./index";

export interface PopStateWindowLike {
  history: {
    readonly state: unknown;
    pushState(data: unknown, unused: string, url?: string | URL | null): void;
    replaceState(data: unknown, unused: string, url?: string | URL | null): void;
    go(delta?: number): void;
  };
  addEventListener(type: "popstate", listener: (event: PopStateEvent) => void): void;
  removeEventListener(type: "popstate", listener: (event: PopStateEvent) => void): void;
  dispatchEvent(event: Event): boolean;
}

export interface WebPopStateGuardController {
  install(): void;
  register(guard: RouteLeaveGuard | null): () => void;
  dispose(): void;
}

function readHistoryStateId(state: unknown): string | null {
  if (typeof state === "object" && state !== null && "id" in state) {
    const id = (state as { id?: unknown }).id;
    return typeof id === "string" && id.length > 0 ? id : null;
  }
  return null;
}

function createPopStateEvent(state: unknown): PopStateEvent {
  if (typeof PopStateEvent === "function") {
    return new PopStateEvent("popstate", { state });
  }
  const event = new Event("popstate") as PopStateEvent;
  Object.defineProperty(event, "state", { value: state });
  return event;
}

/**
 * Intercepts browser Back/Forward (`popstate`) before Expo Router's
 * `createMemoryHistory` listener runs.
 *
 * Tracks the ordered history entry IDs written by Expo Router so canceling any
 * traversal (including multi-step Back-menu jumps) reverts via `history.go(delta)`
 * without calling `pushState` or truncating intervening entries, and confirming
 * replays `popstate` at the browser's exact selected destination.
 */
export function createWebPopStateGuard(win: PopStateWindowLike): WebPopStateGuardController {
  let installed = false;
  let activeGuard: RouteLeaveGuard | null = null;
  let confirmInFlight = false;
  let isReverting = false;
  let isReplaying = false;
  let revertResetTimer: ReturnType<typeof setTimeout> | null = null;
  let entryIds: Array<string | null> = [];
  let currentIdx = 0;

  let origPushState: PopStateWindowLike["history"]["pushState"] | null = null;
  let origReplaceState: PopStateWindowLike["history"]["replaceState"] | null = null;

  const clearRevertTimer = () => {
    if (revertResetTimer !== null) {
      clearTimeout(revertResetTimer);
      revertResetTimer = null;
    }
  };

  const revertToCurrent = (returnDelta: number) => {
    isReverting = true;
    clearRevertTimer();
    revertResetTimer = setTimeout(() => {
      isReverting = false;
      revertResetTimer = null;
    }, 250);
    win.history.go(returnDelta);
  };

  const resolveTargetIndex = (state: unknown): number => {
    const targetId = readHistoryStateId(state);
    if (!targetId) {
      return -1;
    }
    return entryIds.indexOf(targetId);
  };

  const handlePopState = (event: PopStateEvent) => {
    if (isReverting) {
      isReverting = false;
      clearRevertTimer();
      event.stopImmediatePropagation();
      return;
    }

    const targetIdx = resolveTargetIndex(event.state);

    if (isReplaying) {
      isReplaying = false;
      if (targetIdx >= 0) {
        currentIdx = targetIdx;
      }
      return;
    }

    const guard = activeGuard;
    if (!guard?.isDirty()) {
      if (targetIdx >= 0) {
        currentIdx = targetIdx;
      }
      return;
    }

    event.stopImmediatePropagation();
    const returnDelta = targetIdx >= 0 ? currentIdx - targetIdx : 1;

    if (confirmInFlight) {
      if (returnDelta !== 0) {
        revertToCurrent(returnDelta);
      }
      return;
    }

    confirmInFlight = true;
    const confirmAndResolve = async () => {
      try {
        const confirmed = await guard.confirmDiscard();
        if (confirmed) {
          isReplaying = true;
          win.dispatchEvent(createPopStateEvent(event.state));
        } else if (returnDelta !== 0) {
          revertToCurrent(returnDelta);
        }
      } finally {
        confirmInFlight = false;
      }
    };
    void confirmAndResolve();
  };

  return {
    install() {
      if (installed) {
        return;
      }
      installed = true;
      entryIds = [readHistoryStateId(win.history.state)];
      currentIdx = 0;

      origPushState = win.history.pushState;
      origReplaceState = win.history.replaceState;

      win.history.pushState = (data, unused, url) => {
        origPushState?.call(win.history, data, unused, url);
        entryIds = entryIds.slice(0, currentIdx + 1);
        entryIds.push(readHistoryStateId(data));
        currentIdx = entryIds.length - 1;
      };

      win.history.replaceState = (data, unused, url) => {
        origReplaceState?.call(win.history, data, unused, url);
        entryIds[currentIdx] = readHistoryStateId(data);
      };

      win.addEventListener("popstate", handlePopState);
    },
    register(guard) {
      activeGuard = guard;
      return () => {
        if (activeGuard === guard) {
          activeGuard = null;
        }
      };
    },
    dispose() {
      if (!installed) {
        return;
      }
      installed = false;
      activeGuard = null;
      confirmInFlight = false;
      isReverting = false;
      isReplaying = false;
      clearRevertTimer();
      win.removeEventListener("popstate", handlePopState);
      if (origPushState) {
        win.history.pushState = origPushState;
        origPushState = null;
      }
      if (origReplaceState) {
        win.history.replaceState = origReplaceState;
        origReplaceState = null;
      }
    },
  };
}

let sharedController: WebPopStateGuardController | null = null;

function getSharedController(): WebPopStateGuardController | null {
  if (typeof window === "undefined") {
    return null;
  }
  if (!sharedController) {
    sharedController = createWebPopStateGuard(window);
  }
  return sharedController;
}

export function installRouteLeavePopStateGuard(): void {
  getSharedController()?.install();
}

export function registerRouteLeaveGuard(guard: RouteLeaveGuard | null): () => void {
  const controller = getSharedController();
  if (!controller) {
    return () => {};
  }
  controller.install();
  return controller.register(guard);
}
