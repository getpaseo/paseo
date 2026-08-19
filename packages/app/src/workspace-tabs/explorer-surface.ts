import { supportsDesktopPaneSplits } from "@/constants/layout";
import {
  usePanelStore,
  selectIsCompactFileExplorerOpen,
  type ExplorerTab,
} from "@/stores/panel-store";
import type { ExplorerCheckoutContext } from "@/stores/explorer-checkout-context";
import {
  collectAllTabs,
  findPaneById,
  resolveExplorerPaneId,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

/**
 * The explorer has three surfaces, picked from two facts — is the layout compact,
 * and can this platform render split panes:
 *
 *   compact                → slide-over overlay, owned by the panel store
 *   non-compact + splits   → dedicated right pane, owned by the layout store
 *   non-compact, no splits → ordinary tabs in the focused pane (native tablets)
 *
 * Every entry point goes through this module. Nothing else branches on the surface —
 * the third case is why: a native tablet renders one pane at a time and the tab row
 * only lists the focused pane's tabs, so anything routed into a separate explorer
 * pane there would silently disappear.
 */

/** Tab kinds that are explorer views rather than user content. */
const EXPLORER_TAB_KINDS = ["working_diff", "files", "pull_request"] as const;
type ExplorerTabKind = (typeof EXPLORER_TAB_KINDS)[number];

const EXPLORER_VIEW_TARGETS: Record<ExplorerTab, WorkspaceTabTarget> = {
  changes: { kind: "working_diff" },
  files: { kind: "files" },
  pr: { kind: "pull_request" },
};

export interface ExplorerSurfaceQuery {
  isCompact: boolean;
  workspaceKey: string | null;
}

export interface ExplorerSurfaceInput extends ExplorerSurfaceQuery {
  checkout: ExplorerCheckoutContext | null;
}

type LayoutState = ReturnType<typeof useWorkspaceLayoutStore.getState>;

function isExplorerTabKind(kind: string): kind is ExplorerTabKind {
  return (EXPLORER_TAB_KINDS as readonly string[]).includes(kind);
}

function canUseExplorerPane(isCompact: boolean): boolean {
  return !isCompact && supportsDesktopPaneSplits();
}

// ─── Explorer pane (non-compact + splits) ──────────────────────────────────

function findExplorerPane(state: LayoutState, workspaceKey: string) {
  const layout = state.layoutByWorkspace[workspaceKey];
  if (!layout) {
    return null;
  }
  const paneId = resolveExplorerPaneId(layout, state.explorerPaneIdByWorkspace[workspaceKey]);
  return paneId ? findPaneById(layout.root, paneId) : null;
}

function selectIsExplorerPaneOpen(state: LayoutState, workspaceKey: string | null): boolean {
  if (!workspaceKey) {
    return false;
  }
  const pane = findExplorerPane(state, workspaceKey);
  return Boolean(pane && pane.hidden !== true);
}

// ─── Explorer tabs (non-compact, no splits) ────────────────────────────────

/**
 * The explorer tab the focused pane is currently showing, if any. On a tablet
 * "the explorer is open" means exactly that — there is no pane to hide.
 */
function findActiveExplorerTabId(state: LayoutState, workspaceKey: string): string | null {
  const layout = state.layoutByWorkspace[workspaceKey];
  if (!layout) {
    return null;
  }
  const focusedTabId = findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId ?? null;
  if (!focusedTabId) {
    return null;
  }
  const tab = collectAllTabs(layout.root).find((candidate) => candidate.tabId === focusedTabId);
  return tab && isExplorerTabKind(tab.target.kind) ? tab.tabId : null;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Open a tab alongside the current one. With splits it lands in the explorer
 * pane; without them it opens in the focused pane, because that is the only
 * pane the user can see.
 */
export function openWorkspaceTabBeside(input: {
  isCompact: boolean;
  workspaceKey: string | null;
  target: WorkspaceTabTarget;
  parentTabId?: string | null;
}): string | null {
  if (!input.workspaceKey) {
    return null;
  }
  const store = useWorkspaceLayoutStore.getState();
  const parentTabId = input.parentTabId?.trim() || null;

  if (canUseExplorerPane(input.isCompact)) {
    return store.openTabInExplorerPaneFocused(input.workspaceKey, {
      target: input.target,
      parentTabId,
    });
  }

  return parentTabId
    ? store.openChildTabInFocusedPane(input.workspaceKey, input.target, parentTabId)
    : store.openTabInFocusedPane(input.workspaceKey, input.target);
}

/** {@link openWorkspaceTabBeside} without moving focus. */
export function openWorkspaceTabBesideInBackground(input: {
  isCompact: boolean;
  workspaceKey: string | null;
  target: WorkspaceTabTarget;
}): string | null {
  if (!input.workspaceKey) {
    return null;
  }
  const store = useWorkspaceLayoutStore.getState();
  return canUseExplorerPane(input.isCompact)
    ? store.openTabInExplorerPaneBackground(input.workspaceKey, input.target)
    : store.openTabInBackground(input.workspaceKey, input.target);
}

/** Reveal the explorer showing `view`. */
export function openExplorerSurface(input: ExplorerSurfaceInput & { view: ExplorerTab }): void {
  if (input.isCompact) {
    if (!input.checkout) {
      return;
    }
    const panel = usePanelStore.getState();
    panel.setExplorerTabForCheckout({ ...input.checkout, tab: input.view });
    panel.openCompactFileExplorer(input.checkout);
    return;
  }

  openWorkspaceTabBeside({
    isCompact: input.isCompact,
    workspaceKey: input.workspaceKey,
    target: EXPLORER_VIEW_TARGETS[input.view],
  });
}

/** Show the explorer if it is hidden, hide it if it is showing. */
export function toggleExplorerSurface(input: ExplorerSurfaceInput): void {
  if (input.isCompact) {
    if (input.checkout) {
      usePanelStore.getState().toggleCompactFileExplorer(input.checkout);
    }
    return;
  }
  if (!input.workspaceKey) {
    return;
  }

  const workspaceKey = input.workspaceKey;
  const store = useWorkspaceLayoutStore.getState();

  if (!canUseExplorerPane(input.isCompact)) {
    const activeExplorerTabId = findActiveExplorerTabId(store, workspaceKey);
    if (activeExplorerTabId) {
      store.closeTab(workspaceKey, activeExplorerTabId);
      return;
    }
    store.openTabInFocusedPane(workspaceKey, EXPLORER_VIEW_TARGETS.changes);
    return;
  }

  const layout = store.layoutByWorkspace[workspaceKey];
  const parentTabId = layout
    ? (findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId ?? null)
    : null;
  const explorerPane = findExplorerPane(store, workspaceKey);

  if (explorerPane) {
    if (explorerPane.hidden !== true) {
      store.hidePane(workspaceKey, explorerPane.id);
      return;
    }
    store.showPane(workspaceKey, explorerPane.id);
    // The companion pane can already hold an unrelated tab (the setup progress
    // tab auto-opens here) before the user ever toggles it, so "empty" is the
    // wrong signal for "needs a Changes tab seeded". Check for it specifically.
    const layoutTabs = layout ? collectAllTabs(layout.root) : [];
    const hasChangesTab = explorerPane.tabIds.some(
      (tabId) => layoutTabs.find((tab) => tab.tabId === tabId)?.target.kind === "working_diff",
    );
    if (hasChangesTab) {
      return;
    }
  }

  store.openTabInExplorerPaneFocused(workspaceKey, {
    target: EXPLORER_VIEW_TARGETS.changes,
    parentTabId,
  });
}

/** Reactive "is the explorer showing" for the surface this layout uses. */
export function useIsExplorerSurfaceOpen(input: ExplorerSurfaceQuery): boolean {
  const compactOpen = usePanelStore(selectIsCompactFileExplorerOpen);
  const paneOpen = useWorkspaceLayoutStore((state) =>
    input.isCompact ? false : isExplorerOpenForLayout(state, input.workspaceKey),
  );
  return input.isCompact ? compactOpen : paneOpen;
}

/** Imperative counterpart of {@link useIsExplorerSurfaceOpen}. */
export function isExplorerSurfaceOpen(input: ExplorerSurfaceQuery): boolean {
  if (input.isCompact) {
    return selectIsCompactFileExplorerOpen(usePanelStore.getState());
  }
  return isExplorerOpenForLayout(useWorkspaceLayoutStore.getState(), input.workspaceKey);
}

function isExplorerOpenForLayout(state: LayoutState, workspaceKey: string | null): boolean {
  if (!workspaceKey) {
    return false;
  }
  return supportsDesktopPaneSplits()
    ? selectIsExplorerPaneOpen(state, workspaceKey)
    : findActiveExplorerTabId(state, workspaceKey) !== null;
}
