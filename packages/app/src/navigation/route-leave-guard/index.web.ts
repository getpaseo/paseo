import type { RouteLeaveGuard } from "./index";

export type { RouteLeaveGuard } from "./index";

const HISTORY_STORAGE_KEY = "@paseo:route-leave-history:v1";
const MAX_REVERT_STEPS = 20;
const REVERT_TIMEOUT_MS = 400;

export interface PopStateStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface PopStateWindowLike {
  history: {
    readonly state: unknown;
    pushState(data: unknown, unused: string, url?: string | URL | null): void;
    replaceState(data: unknown, unused: string, url?: string | URL | null): void;
    go(delta?: number): void;
  };
  sessionStorage?: PopStateStorageLike;
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

function loadStoredEntryIds(storage: PopStateStorageLike | undefined): Array<string | null> | null {
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }
    if (!parsed.every((item) => item === null || typeof item === "string")) {
      return null;
    }
    return parsed as Array<string | null>;
  } catch {
    return null;
  }
}

function persistEntryIds(
  storage: PopStateStorageLike | undefined,
  entryIds: readonly (string | null)[],
): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(entryIds));
  } catch {
    // Ignore storage quota or private-mode restrictions; fallback stepping still works.
  }
}

/**
 * Intercepts browser Back/Forward (`popstate`) before Expo Router's
 * `createMemoryHistory` listener runs.
 *
 * Tracks the ordered history entry IDs written by Expo Router (persisted in
 * `sessionStorage` so reloads keep the tab's full index). Canceling any
 * traversal reverts via `history.go(delta)` without calling `pushState` or
 * truncating intervening entries — and verifies it landed back on the saved
 * entry ID (stepping forward if pre-reload history was unknown). Confirming
 * replays `popstate` at the browser's exact selected destination.
 */
export function createWebPopStateGuard(win: PopStateWindowLike): WebPopStateGuardController {
  let installed = false;
  let activeGuard: RouteLeaveGuard | null = null;
  let confirmInFlight = false;
  let isReverting = false;
  let revertingTargetId: string | null = null;
  let revertStepDirection: 1 | -1 = 1;
  let revertStepsRemaining = 0;
  let isReplaying = false;
  let revertResetTimer: ReturnType<typeof setTimeout> | null = null;
  let entryIds: Array<string | null> = [];
  let currentIdx = 0;

  let origPushState: PopStateWindowLike["history"]["pushState"] | null = null;
  let origReplaceState: PopStateWindowLike["history"]["replaceState"] | null = null;

  const clearRevertState = () => {
    isReverting = false;
    revertingTargetId = null;
    revertStepsRemaining = 0;
    if (revertResetTimer !== null) {
      clearTimeout(revertResetTimer);
      revertResetTimer = null;
    }
  };

  const armRevertTimer = () => {
    if (revertResetTimer !== null) {
      clearTimeout(revertResetTimer);
    }
    revertResetTimer = setTimeout(() => {
      clearRevertState();
    }, REVERT_TIMEOUT_MS);
  };

  const revertToSavedEntry = (savedId: string | null, returnDelta: number) => {
    isReverting = true;
    revertingTargetId = savedId;
    revertStepDirection = returnDelta >= 0 ? 1 : -1;
    revertStepsRemaining = MAX_REVERT_STEPS;
    armRevertTimer();
    win.history.go(returnDelta);
  };

  const resolveTargetIndex = (state: unknown): number => {
    const targetId = readHistoryStateId(state);
    if (!targetId) {
      return -1;
    }
    return entryIds.indexOf(targetId);
  };

  const handleRevertPopState = (event: PopStateEvent) => {
    event.stopImmediatePropagation();
    const landedId = readHistoryStateId(event.state);
    if (revertingTargetId !== null && landedId !== revertingTargetId && revertStepsRemaining > 0) {
      revertStepsRemaining -= 1;
      armRevertTimer();
      win.history.go(revertStepDirection);
      return;
    }
    const landedIdx = resolveTargetIndex(event.state);
    if (landedIdx >= 0) {
      currentIdx = landedIdx;
    }
    clearRevertState();
  };

  const handlePopState = (event: PopStateEvent) => {
    if (isReverting) {
      handleRevertPopState(event);
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
    const savedId = entryIds[currentIdx] ?? null;
    const returnDelta = targetIdx >= 0 ? currentIdx - targetIdx : 1;

    if (confirmInFlight) {
      if (returnDelta !== 0) {
        revertToSavedEntry(savedId, returnDelta);
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
          revertToSavedEntry(savedId, returnDelta);
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
      const initialId = readHistoryStateId(win.history.state);
      const stored = loadStoredEntryIds(win.sessionStorage);
      const storedIdx = stored && initialId ? stored.indexOf(initialId) : -1;
      if (stored && storedIdx >= 0) {
        entryIds = stored;
        currentIdx = storedIdx;
      } else {
        entryIds = [initialId];
        currentIdx = 0;
        persistEntryIds(win.sessionStorage, entryIds);
      }

      origPushState = win.history.pushState;
      origReplaceState = win.history.replaceState;

      win.history.pushState = (data, unused, url) => {
        origPushState?.call(win.history, data, unused, url);
        entryIds = entryIds.slice(0, currentIdx + 1);
        entryIds.push(readHistoryStateId(data));
        currentIdx = entryIds.length - 1;
        persistEntryIds(win.sessionStorage, entryIds);
      };

      win.history.replaceState = (data, unused, url) => {
        origReplaceState?.call(win.history, data, unused, url);
        entryIds[currentIdx] = readHistoryStateId(data);
        persistEntryIds(win.sessionStorage, entryIds);
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
      isReplaying = false;
      clearRevertState();
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
