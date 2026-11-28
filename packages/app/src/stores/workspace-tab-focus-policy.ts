/**
 * Per-pane tab focus recency, ordered most-recently-focused first.
 * Kept in memory rather than persisted so strict layout storage stays unchanged.
 */
export type PaneTabFocusHistory = Record<string, readonly string[]>;

/**
 * Why a pane is losing its currently focused tab:
 * - "close": browser-style close returns to the tab's parent (if still open anywhere),
 *   otherwise steps to the adjacent neighbor (right, then left).
 * - "relocate": split or move keeps the user's working context visible in the source pane
 *   by returning to the most recently focused remaining tab in that pane, then a same-pane
 *   parent tab (for example immediately after reload), then the adjacent neighbor.
 */
export type TabDepartureReason = "close" | "relocate";

export interface PaneFocusSnapshot {
  id: string;
  tabIds: readonly string[];
  focusedTabId: string | null;
}

export interface TabDepartureContext {
  pane: PaneFocusSnapshot;
  departingTabId: string;
  openTabIds: ReadonlySet<string>;
  parentTabIdByTabId?: Record<string, string>;
  paneFocusHistory?: PaneTabFocusHistory;
}

type TabSuccessorRule = (context: TabDepartureContext) => string | null;

function isRemainingInSourcePane(context: TabDepartureContext, tabId: string | null): boolean {
  return Boolean(tabId && tabId !== context.departingTabId && context.pane.tabIds.includes(tabId));
}

const mostRecentlyFocusedInSourcePane: TabSuccessorRule = (context) => {
  const recent = context.paneFocusHistory?.[context.pane.id];
  return recent?.find((tabId) => isRemainingInSourcePane(context, tabId)) ?? null;
};

const openParentTabAnywhere: TabSuccessorRule = (context) => {
  const parentTabId = context.parentTabIdByTabId?.[context.departingTabId] ?? null;
  return parentTabId &&
    parentTabId !== context.departingTabId &&
    context.openTabIds.has(parentTabId)
    ? parentTabId
    : null;
};

const parentTabInSourcePane: TabSuccessorRule = (context) => {
  const parentTabId = context.parentTabIdByTabId?.[context.departingTabId] ?? null;
  return isRemainingInSourcePane(context, parentTabId) ? parentTabId : null;
};

const adjacentNeighborInSourcePane: TabSuccessorRule = (context) => {
  const tabIndex = context.pane.tabIds.indexOf(context.departingTabId);
  if (tabIndex < 0) {
    return null;
  }
  return (
    context.pane.tabIds[tabIndex + 1] ??
    (tabIndex > 0 ? context.pane.tabIds[tabIndex - 1] : null) ??
    null
  );
};

export const TAB_DEPARTURE_POLICIES: Record<TabDepartureReason, readonly TabSuccessorRule[]> = {
  close: [openParentTabAnywhere, adjacentNeighborInSourcePane],
  relocate: [mostRecentlyFocusedInSourcePane, parentTabInSourcePane, adjacentNeighborInSourcePane],
};

export function resolveTabDepartureSuccessor(
  reason: TabDepartureReason,
  context: TabDepartureContext,
): string | null {
  if (context.pane.focusedTabId !== context.departingTabId) {
    return null;
  }
  for (const rule of TAB_DEPARTURE_POLICIES[reason]) {
    const candidate = rule(context);
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

function mapRenamedTabId(
  tabId: string | null | undefined,
  renamedTab: { from: string; to: string } | null | undefined,
): string | null {
  if (!tabId) {
    return null;
  }
  return renamedTab && tabId === renamedTab.from ? renamedTab.to : tabId;
}

export function syncPaneTabFocusHistory(input: {
  previousHistory: PaneTabFocusHistory | undefined;
  previousPanes: readonly PaneFocusSnapshot[];
  nextPanes: readonly PaneFocusSnapshot[];
  renamedTab?: { from: string; to: string } | null;
}): PaneTabFocusHistory {
  const previous = input.previousHistory ?? {};
  const previousFocusedByPaneId = new Map(
    input.previousPanes.map((pane) => [pane.id, pane.focusedTabId]),
  );
  const next: Record<string, readonly string[]> = {};
  let changed = Object.keys(previous).length !== input.nextPanes.length;

  for (const pane of input.nextPanes) {
    const openInPane = new Set(pane.tabIds);
    const priorEntries = previous[pane.id] ?? [];
    const updated: string[] = [];
    const seen = new Set<string>();

    const pushIfOpen = (tabId: string | null | undefined) => {
      if (!tabId || seen.has(tabId) || !openInPane.has(tabId)) {
        return;
      }
      seen.add(tabId);
      updated.push(tabId);
    };

    pushIfOpen(pane.focusedTabId);
    // Seed from the pane's prior focused tab so the first switch after hydration remembers it.
    pushIfOpen(mapRenamedTabId(previousFocusedByPaneId.get(pane.id), input.renamedTab));
    for (const entry of priorEntries) {
      pushIfOpen(mapRenamedTabId(entry, input.renamedTab));
    }

    if (
      !changed &&
      (priorEntries.length !== updated.length ||
        priorEntries.some((entry, index) => entry !== updated[index]))
    ) {
      changed = true;
    }

    next[pane.id] = updated;
  }

  return changed ? next : previous;
}
