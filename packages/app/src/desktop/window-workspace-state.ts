import { useSyncExternalStore } from "react";
import { listenToDesktopEvent, type DesktopEventUnlisten } from "@/desktop/electron/events";
import { getDesktopWindow } from "@/desktop/electron/window";
import type { DesktopWorkspaceWindowState as DesktopWorkspaceWindowBridgeState } from "@/desktop/host";

export interface DesktopWorkspaceWindowStateSnapshot {
  isReady: boolean;
  windowId: number | null;
  isPrimary: boolean;
  workspaceOwners: Record<string, number>;
}

const EMPTY_WORKSPACE_OWNERS: Record<string, number> = {};
const INITIAL_STATE: DesktopWorkspaceWindowStateSnapshot = {
  isReady: false,
  windowId: null,
  isPrimary: true,
  workspaceOwners: EMPTY_WORKSPACE_OWNERS,
};
const UNSUPPORTED_STATE: DesktopWorkspaceWindowStateSnapshot = {
  isReady: true,
  windowId: null,
  isPrimary: true,
  workspaceOwners: EMPTY_WORKSPACE_OWNERS,
};

let currentState = INITIAL_STATE;
let initPromise: Promise<void> | null = null;
let eventUnlisten: DesktopEventUnlisten | null = null;
const listeners = new Set<() => void>();

function normalizeWorkspaceState(
  input: unknown,
): DesktopWorkspaceWindowStateSnapshot | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const state = input as Partial<DesktopWorkspaceWindowBridgeState>;
  if (typeof state.windowId !== "number" || !Number.isFinite(state.windowId)) {
    return null;
  }

  const workspaceOwners: Record<string, number> = {};
  if (state.workspaceOwners && typeof state.workspaceOwners === "object") {
    for (const [key, value] of Object.entries(state.workspaceOwners)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        workspaceOwners[key] = value;
      }
    }
  }

  return {
    isReady: true,
    windowId: state.windowId,
    isPrimary: state.isPrimary === true,
    workspaceOwners,
  };
}

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function statesEqual(
  left: DesktopWorkspaceWindowStateSnapshot,
  right: DesktopWorkspaceWindowStateSnapshot,
): boolean {
  if (
    left === right ||
    (left.isReady === right.isReady &&
      left.windowId === right.windowId &&
      left.isPrimary === right.isPrimary)
  ) {
    const leftEntries = Object.entries(left.workspaceOwners);
    const rightEntries = Object.entries(right.workspaceOwners);
    if (leftEntries.length !== rightEntries.length) {
      return false;
    }
    for (const [key, value] of leftEntries) {
      if (right.workspaceOwners[key] !== value) {
        return false;
      }
    }
    return true;
  }

  return false;
}

function setState(nextState: DesktopWorkspaceWindowStateSnapshot): void {
  if (statesEqual(currentState, nextState)) {
    return;
  }
  currentState = nextState;
  emitChange();
}

async function ensureInitialized(): Promise<void> {
  if (initPromise) {
    return await initPromise;
  }

  initPromise = (async () => {
    const desktopWindow = getDesktopWindow();
    if (!desktopWindow || typeof desktopWindow.getWorkspaceState !== "function") {
      setState(UNSUPPORTED_STATE);
      return;
    }

    try {
      eventUnlisten = await listenToDesktopEvent<unknown>("window-workspace-state", (payload) => {
        const nextState = normalizeWorkspaceState(payload);
        if (nextState) {
          setState(nextState);
        }
      });
    } catch {
      eventUnlisten = null;
    }

    try {
      const nextState = normalizeWorkspaceState(await desktopWindow.getWorkspaceState());
      setState(nextState ?? UNSUPPORTED_STATE);
    } catch {
      setState(UNSUPPORTED_STATE);
    }
  })();

  return await initPromise;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  void ensureInitialized();

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      eventUnlisten?.();
      eventUnlisten = null;
      initPromise = null;
      currentState = INITIAL_STATE;
    }
  };
}

function getSnapshot(): DesktopWorkspaceWindowStateSnapshot {
  return currentState;
}

export function useDesktopWorkspaceWindowState(): DesktopWorkspaceWindowStateSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function toWorkspaceKey(serverId: string, workspaceId: string): string | null {
  const normalizedServerId = serverId.trim();
  const normalizedWorkspaceId = workspaceId.trim();
  if (!normalizedServerId || !normalizedWorkspaceId) {
    return null;
  }
  return `${normalizedServerId}:${normalizedWorkspaceId}`;
}

export function isWorkspaceVisibleInDesktopWindow(
  state: DesktopWorkspaceWindowStateSnapshot,
  serverId: string,
  workspaceId: string,
): boolean {
  const workspaceKey = toWorkspaceKey(serverId, workspaceId);
  if (!workspaceKey) {
    return false;
  }
  if (!state.isReady || state.windowId === null) {
    return true;
  }

  const ownerWindowId = state.workspaceOwners[workspaceKey];
  if (typeof ownerWindowId !== "number") {
    return state.isPrimary;
  }
  return ownerWindowId === state.windowId;
}

export async function claimWorkspaceInCurrentWindow(
  serverId: string,
  workspaceId: string,
): Promise<boolean> {
  const desktopWindow = getDesktopWindow();
  if (!desktopWindow || typeof desktopWindow.claimWorkspace !== "function") {
    return false;
  }
  const workspaceKey = toWorkspaceKey(serverId, workspaceId);
  if (!workspaceKey) {
    return false;
  }
  return await desktopWindow.claimWorkspace({ serverId: serverId.trim(), workspaceId: workspaceId.trim() });
}

export async function moveWorkspaceToNewDesktopWindow(
  serverId: string,
  workspaceId: string,
): Promise<boolean> {
  const desktopWindow = getDesktopWindow();
  if (!desktopWindow || typeof desktopWindow.moveWorkspaceToNewWindow !== "function") {
    return false;
  }
  const workspaceKey = toWorkspaceKey(serverId, workspaceId);
  if (!workspaceKey) {
    return false;
  }
  return await desktopWindow.moveWorkspaceToNewWindow({
    serverId: serverId.trim(),
    workspaceId: workspaceId.trim(),
  });
}
