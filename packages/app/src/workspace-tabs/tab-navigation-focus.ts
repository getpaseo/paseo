import { useCallback, useSyncExternalStore } from "react";

const suppressedTabByWorkspace = new Map<string, string>();
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function blurActiveSurfaceForTabCycle(): void {
  if (typeof document === "undefined") return;
  const active = document.activeElement;
  if (
    active instanceof HTMLElement &&
    active !== document.body &&
    active !== document.documentElement
  ) {
    active.blur();
  }
}

/**
 * Marks `tabId` as revealed by relative keyboard tab cycling so auto-focusing
 * surfaces (chat composer, terminal) do not steal focus and trap `Cmd+Arrow`
 * tab navigation.
 */
export function suppressWorkspaceTabAutoFocus(workspaceKey: string, tabId: string): void {
  if (!workspaceKey || !tabId) return;
  blurActiveSurfaceForTabCycle();
  if (suppressedTabByWorkspace.get(workspaceKey) === tabId) return;
  suppressedTabByWorkspace.set(workspaceKey, tabId);
  emitChange();
}

export function clearWorkspaceTabAutoFocusSuppression(workspaceKey: string | null): void {
  if (!workspaceKey) return;
  if (!suppressedTabByWorkspace.delete(workspaceKey)) return;
  emitChange();
}

export function isWorkspaceTabAutoFocusSuppressed(
  workspaceKey: string | null,
  tabId: string | null,
): boolean {
  if (!workspaceKey || !tabId) return false;
  return suppressedTabByWorkspace.get(workspaceKey) === tabId;
}

export function useIsWorkspaceTabAutoFocusSuppressed(
  workspaceKey: string | null,
  tabId: string | null,
): boolean {
  const getSnapshot = useCallback(
    () => isWorkspaceTabAutoFocusSuppressed(workspaceKey, tabId),
    [tabId, workspaceKey],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
