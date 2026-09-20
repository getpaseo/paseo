import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { workspaceTabTargetsEqual } from "@/workspace-tabs/identity";
import type { ExplorerTab, MobilePanelView } from "@/stores/panel-store";

export interface NavigationViewState {
  panel: MobilePanelView;
  explorerTab: ExplorerTab;
}

export interface WorkspaceFocusLocation {
  kind: "workspace";
  serverId: string;
  workspaceId: string;
  paneId: string | null;
  tabId: string | null;
  target: WorkspaceTabTarget | null;
  view: NavigationViewState;
}

export interface RouteFocusLocation {
  kind: "route";
  pathname: string;
}

export type NavigationFocusLocation = WorkspaceFocusLocation | RouteFocusLocation;

export interface NavigationFocusHistorySnapshot {
  canGoBack: boolean;
  current: NavigationFocusLocation | null;
  restoring: boolean;
}

const MAX_HISTORY_LENGTH = 50;

function targetsEqual(left: WorkspaceTabTarget | null, right: WorkspaceTabTarget | null): boolean {
  if (!left || !right) {
    return left === right;
  }
  return workspaceTabTargetsEqual(left, right);
}

export function navigationFocusLocationsEqual(
  left: NavigationFocusLocation | null,
  right: NavigationFocusLocation | null,
): boolean {
  if (!left || !right || left.kind !== right.kind) {
    return left === right;
  }
  if (left.kind === "route" && right.kind === "route") {
    return left.pathname === right.pathname;
  }
  if (left.kind !== "workspace" || right.kind !== "workspace") {
    return false;
  }
  return (
    left.serverId === right.serverId &&
    left.workspaceId === right.workspaceId &&
    left.paneId === right.paneId &&
    left.tabId === right.tabId &&
    targetsEqual(left.target, right.target) &&
    left.view.panel === right.view.panel &&
    left.view.explorerTab === right.view.explorerTab
  );
}

function locationsShareRoute(
  left: NavigationFocusLocation,
  right: NavigationFocusLocation,
): boolean {
  if (left.kind === "route" && right.kind === "route") {
    return left.pathname === right.pathname;
  }
  return (
    left.kind === "workspace" &&
    right.kind === "workspace" &&
    left.serverId === right.serverId &&
    left.workspaceId === right.workspaceId
  );
}

export function createNavigationFocusHistory(maxLength = MAX_HISTORY_LENGTH) {
  let current: NavigationFocusLocation | null = null;
  let past: NavigationFocusLocation[] = [];
  let pendingRestore: NavigationFocusLocation | null = null;
  let snapshot: NavigationFocusHistorySnapshot = {
    canGoBack: false,
    current: null,
    restoring: false,
  };
  const listeners = new Set<() => void>();

  function publish(): void {
    snapshot = {
      canGoBack: pendingRestore === null && past.length > 0,
      current,
      restoring: pendingRestore !== null,
    };
    for (const listener of listeners) {
      listener();
    }
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getSnapshot(): NavigationFocusHistorySnapshot {
      return snapshot;
    },

    record(next: NavigationFocusLocation): void {
      if (pendingRestore) {
        if (!locationsShareRoute(next, pendingRestore)) {
          return;
        }
        current = next;
        pendingRestore = null;
        publish();
        return;
      }

      if (navigationFocusLocationsEqual(current, next)) {
        return;
      }
      if (current) {
        past = [...past, current].slice(-maxLength);
      }
      current = next;
      publish();
    },

    back(): NavigationFocusLocation | null {
      if (pendingRestore || past.length === 0) {
        return null;
      }
      const target = past[past.length - 1] ?? null;
      if (!target) {
        return null;
      }
      past = past.slice(0, -1);
      pendingRestore = target;
      publish();
      return target;
    },

    cancelRestore(): void {
      if (!pendingRestore) {
        return;
      }
      pendingRestore = null;
      publish();
    },

    reset(): void {
      current = null;
      past = [];
      pendingRestore = null;
      publish();
    },
  };
}

export type NavigationFocusHistory = ReturnType<typeof createNavigationFocusHistory>;

export const navigationFocusHistory = createNavigationFocusHistory();
