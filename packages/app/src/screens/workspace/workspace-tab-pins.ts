import type { WorkspaceTabTarget } from "@/stores/workspace-tabs-store";
import { buildDeterministicWorkspaceTabId } from "@/workspace-tabs/identity";

// Pin keys are deterministic tab ids so the same tab resolves to the same key
// on every device; the key list itself lives on the daemon's workspace record.
export function workspaceTabPinKey(target: WorkspaceTabTarget): string {
  return buildDeterministicWorkspaceTabId(target);
}

export function isWorkspaceTabPinned(
  pinnedTabKeys: readonly string[],
  target: WorkspaceTabTarget,
): boolean {
  return pinnedTabKeys.includes(workspaceTabPinKey(target));
}

export function toggleWorkspaceTabPinKey(
  pinnedTabKeys: readonly string[],
  target: WorkspaceTabTarget,
): string[] {
  const key = workspaceTabPinKey(target);
  const next = pinnedTabKeys.filter((entry) => entry !== key);
  if (next.length === pinnedTabKeys.length) {
    next.push(key);
  }
  return next;
}

// Pinned tabs render first, ordered by their position in the pin list (pin
// order); unpinned tabs keep their local order. Pin keys with no matching open
// tab are ignored.
export function sortWorkspaceTabsPinnedFirst<T>(
  tabs: readonly T[],
  pinnedTabKeys: readonly string[],
  getTarget: (tab: T) => WorkspaceTabTarget,
): T[] {
  if (pinnedTabKeys.length === 0) {
    return [...tabs];
  }
  const pinned: T[] = [];
  const unpinned: T[] = [];
  for (const tab of tabs) {
    if (isWorkspaceTabPinned(pinnedTabKeys, getTarget(tab))) {
      pinned.push(tab);
    } else {
      unpinned.push(tab);
    }
  }
  pinned.sort(
    (a, b) =>
      pinnedTabKeys.indexOf(workspaceTabPinKey(getTarget(a))) -
      pinnedTabKeys.indexOf(workspaceTabPinKey(getTarget(b))),
  );
  return [...pinned, ...unpinned];
}
