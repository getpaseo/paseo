import type { RouteLeaveGuard } from "./index";

export type { RouteLeaveGuard, RouteLeaveHistoryEntry } from "./index";

export interface PopStateWindowLike {
  location: { pathname: string; search: string; hash: string };
  history: {
    pushState(data: unknown, unused: string, url?: string | URL | null): void;
    back(): void;
  };
  addEventListener(type: "popstate", listener: (event: PopStateEvent) => void): void;
  removeEventListener(type: "popstate", listener: (event: PopStateEvent) => void): void;
}

export interface WebPopStateGuardController {
  install(): void;
  register(guard: RouteLeaveGuard | null): () => void;
  dispose(): void;
}

/**
 * Intercepts browser Back/Forward (`popstate`) before Expo Router's
 * `createMemoryHistory` listener runs. Expo Router resets its root navigator on
 * `popstate`, which bypasses child screen `beforeRemove` listeners; stopping
 * propagation here lets the active draft veto the exit and keep both route and state.
 */
export function createWebPopStateGuard(win: PopStateWindowLike): WebPopStateGuardController {
  let installed = false;
  let activeGuard: RouteLeaveGuard | null = null;
  let confirmInFlight = false;

  const restoreEntry = (guard: RouteLeaveGuard) => {
    const saved = guard.getCurrentEntry();
    if (!saved) {
      return;
    }
    const currentPath = `${win.location.pathname}${win.location.search}${win.location.hash}`;
    if (currentPath !== saved.path) {
      win.history.pushState(saved.state, "", saved.path);
    }
  };

  const handlePopState = (event: PopStateEvent) => {
    const guard = activeGuard;
    if (!guard?.isDirty()) {
      return;
    }
    event.stopImmediatePropagation();
    restoreEntry(guard);
    if (confirmInFlight) {
      return;
    }
    confirmInFlight = true;
    const confirmAndReplay = async () => {
      try {
        const confirmed = await guard.confirmDiscard();
        if (confirmed) {
          win.history.back();
        }
      } finally {
        confirmInFlight = false;
      }
    };
    void confirmAndReplay();
  };

  return {
    install() {
      if (installed) {
        return;
      }
      installed = true;
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
      win.removeEventListener("popstate", handlePopState);
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
