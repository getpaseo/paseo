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
  selectIsSidePanelVisible,
  selectSidePanelPaneId,
  useWorkspaceLayoutStore,
  type WorkspaceTabPlacement,
} from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { workspaceTabTargetsEqual } from "@/workspace-tabs/identity";

/**
 * The side panel is the companion surface beside the user's work — Changes, Files,
 * the pull request, and anything an agent asks to show alongside its output. It has
 * three renderings, picked from two facts — is the layout compact, and can this
 * platform render split panes:
 *
 *   compact                → slide-over overlay, owned by the panel store
 *   non-compact + splits   → dedicated right pane, owned by the layout store
 *   non-compact, no splits → ordinary tabs in the focused pane (native tablets)
 *
 * Every entry point goes through this module. Nothing else branches on the surface —
 * the third case is why: a native tablet renders one pane at a time and the tab row
 * only lists the focused pane's tabs, so anything routed into a separate side panel
 * pane there would silently disappear.
 */

/** Tab kinds that are side panel views rather than user content. */
const SIDE_PANEL_TAB_KINDS = ["working_diff", "files", "pull_request"] as const;
type SidePanelTabKind = (typeof SIDE_PANEL_TAB_KINDS)[number];

const SIDE_PANEL_VIEW_TARGETS: Record<ExplorerTab, WorkspaceTabTarget> = {
  changes: { kind: "working_diff" },
  files: { kind: "files" },
  pr: { kind: "pull_request" },
};

export interface SidePanelQuery {
  isCompact: boolean;
  workspaceKey: string | null;
  /** Allows callers with known layout capabilities to avoid platform inference. */
  supportsPaneSplits?: boolean;
}

export interface SidePanelInput extends SidePanelQuery {
  checkout: ExplorerCheckoutContext | null;
}

type LayoutState = ReturnType<typeof useWorkspaceLayoutStore.getState>;

function isSidePanelTabKind(kind: string): kind is SidePanelTabKind {
  return (SIDE_PANEL_TAB_KINDS as readonly string[]).includes(kind);
}

function canUseSidePanelPane(input: SidePanelQuery): boolean {
  return !input.isCompact && (input.supportsPaneSplits ?? supportsDesktopPaneSplits());
}

function isTargetVisibleInSidePanel(
  state: LayoutState,
  workspaceKey: string,
  target: WorkspaceTabTarget,
): boolean {
  if (!selectIsSidePanelVisible(state, workspaceKey)) return false;
  const layout = state.layoutByWorkspace[workspaceKey];
  const paneId = selectSidePanelPaneId(state, workspaceKey);
  const focusedTabId = layout && paneId ? findPaneById(layout.root, paneId)?.focusedTabId : null;
  if (!layout || !focusedTabId) return false;
  const focusedTab = collectAllTabs(layout.root).find((tab) => tab.tabId === focusedTabId);
  return Boolean(focusedTab && workspaceTabTargetsEqual(focusedTab.target, target));
}

// ─── Side panel tabs (non-compact, no splits) ──────────────────────────────

/**
 * The side panel tab the focused pane is currently showing, if any. On a tablet
 * "the side panel is open" means exactly that — there is no pane to hide.
 */
function findActiveSidePanelTabId(state: LayoutState, workspaceKey: string): string | null {
  const layout = state.layoutByWorkspace[workspaceKey];
  if (!layout) {
    return null;
  }
  const focusedTabId = findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId ?? null;
  if (!focusedTabId) {
    return null;
  }
  const tab = collectAllTabs(layout.root).find((candidate) => candidate.tabId === focusedTabId);
  return tab && isSidePanelTabKind(tab.target.kind) ? tab.tabId : null;
}

// ─── Public API ────────────────────────────────────────────────────────────

export interface OpenSupportingTabInput extends SidePanelQuery {
  target: WorkspaceTabTarget;
  /** The user's preference for where new supporting tabs land. Ignored on compact. */
  openInSidePanelByDefault: boolean;
  parentTabId?: string | null;
  /** Add the tab without revealing the side panel or moving focus. */
  background?: boolean;
}

export interface ToggleSupportingTabInput extends SidePanelQuery {
  target: WorkspaceTabTarget;
  openInSidePanelByDefault: boolean;
}

/**
 * Opens a tab the user did not place themselves — an agent's file link, a detected
 * pull request, workspace setup progress. A supporting tab that is already open is
 * left where the user put it; only a brand new one follows the preference.
 */
export function openSupportingTab(input: OpenSupportingTabInput): string | null {
  if (!input.workspaceKey) {
    return null;
  }
  const workspaceKey = input.workspaceKey;
  const store = useWorkspaceLayoutStore.getState();
  const background = input.background === true;
  const placement = resolveSidePanelPlacement({
    store,
    workspaceKey,
    routeToSidePanel: input.openInSidePanelByDefault && canUseSidePanelPane(input),
    background,
  });

  if (background) {
    return store.openTab({ workspaceKey, target: input.target, intent: "background", placement });
  }
  return store.openTab({
    workspaceKey,
    target: input.target,
    intent: "reveal",
    placement,
    parentTabId: input.parentTabId ?? undefined,
  });
}

/** Toggle a supporting target when it is the visible Side panel tab; otherwise reveal it. */
export function toggleSupportingTab(input: ToggleSupportingTabInput): string | null {
  if (!input.workspaceKey) return null;
  const store = useWorkspaceLayoutStore.getState();
  if (
    input.openInSidePanelByDefault &&
    canUseSidePanelPane(input) &&
    isTargetVisibleInSidePanel(store, input.workspaceKey, input.target)
  ) {
    store.hideSidePanel(input.workspaceKey);
    return null;
  }
  return openSupportingTab(input);
}

/** Explicitly place a companion tab in the Side panel, moving an existing tab there. */
export function openTabInSidePanel(
  input: SidePanelInput & { target: WorkspaceTabTarget },
): string | null {
  if (!input.workspaceKey) {
    return null;
  }

  if (input.isCompact) {
    const view = Object.entries(SIDE_PANEL_VIEW_TARGETS).find(
      ([, target]) => target.kind === input.target.kind,
    )?.[0] as ExplorerTab | undefined;
    if (!view || !input.checkout) {
      return null;
    }
    const panel = usePanelStore.getState();
    panel.setExplorerTabForCheckout({ ...input.checkout, tab: view });
    panel.openCompactFileExplorer(input.checkout);
    return null;
  }

  const store = useWorkspaceLayoutStore.getState();
  const paneId = canUseSidePanelPane(input) ? store.showSidePanel(input.workspaceKey) : undefined;
  return store.openTab({
    workspaceKey: input.workspaceKey,
    target: input.target,
    intent: "reveal",
    placement: paneId ? { mode: "pane", paneId } : undefined,
  });
}

/**
 * Undefined means "no opinion, use the focused pane". Revealing is part of resolving
 * the side panel: a focused tab in a hidden pane is nothing the user can see, so a
 * visible open brings the panel on screen. A background open never does.
 */
function resolveSidePanelPlacement(input: {
  store: LayoutState;
  workspaceKey: string;
  routeToSidePanel: boolean;
  background: boolean;
}): WorkspaceTabPlacement | undefined {
  if (!input.routeToSidePanel) {
    return undefined;
  }
  const paneId = input.background
    ? selectSidePanelPaneId(input.store, input.workspaceKey)
    : input.store.showSidePanel(input.workspaceKey);
  return paneId ? { mode: "prefer", paneId } : undefined;
}

/** Reveal the side panel showing `view`. */
export function openSidePanelView(input: SidePanelInput & { view: ExplorerTab }): void {
  if (input.isCompact) {
    if (!input.checkout) {
      return;
    }
    const panel = usePanelStore.getState();
    panel.setExplorerTabForCheckout({ ...input.checkout, tab: input.view });
    panel.openCompactFileExplorer(input.checkout);
    return;
  }

  openSupportingTab({
    isCompact: input.isCompact,
    workspaceKey: input.workspaceKey,
    target: SIDE_PANEL_VIEW_TARGETS[input.view],
    openInSidePanelByDefault: true,
  });
}

/** Reveal the side panel without putting anything in it. */
export function showSidePanel(input: SidePanelInput): void {
  if (input.isCompact) {
    if (input.checkout) {
      usePanelStore.getState().openCompactFileExplorer(input.checkout);
    }
    return;
  }
  if (!input.workspaceKey || !canUseSidePanelPane(input)) {
    return;
  }
  useWorkspaceLayoutStore.getState().showSidePanel(input.workspaceKey);
}

/** Put the side panel away. Its tabs stay open, waiting for the next reveal. */
export function hideSidePanel(input: SidePanelInput): void {
  if (input.isCompact) {
    usePanelStore.getState().showMobileAgent();
    return;
  }
  if (!input.workspaceKey) {
    return;
  }

  const store = useWorkspaceLayoutStore.getState();
  if (!canUseSidePanelPane(input)) {
    const activeTabId = findActiveSidePanelTabId(store, input.workspaceKey);
    if (activeTabId) {
      store.closeTab(input.workspaceKey, activeTabId);
    }
    return;
  }
  store.hideSidePanel(input.workspaceKey);
}

/** Show the side panel if it is hidden, hide it if it is showing. */
export function toggleSidePanel(input: SidePanelInput): void {
  if (input.isCompact) {
    if (input.checkout) {
      usePanelStore.getState().toggleCompactFileExplorer(input.checkout);
    }
    return;
  }
  if (!input.workspaceKey) {
    return;
  }

  if (isSidePanelOpen(input)) {
    hideSidePanel(input);
    return;
  }

  // Without splits there is no pane to reveal, so the toggle has to produce a tab.
  if (!canUseSidePanelPane(input)) {
    useWorkspaceLayoutStore.getState().openTab({
      workspaceKey: input.workspaceKey,
      target: SIDE_PANEL_VIEW_TARGETS.changes,
      intent: "reveal",
    });
    return;
  }
  showSidePanel(input);
}

/** Reactive "is the side panel showing" for the surface this layout uses. */
export function useIsSidePanelOpen(input: SidePanelQuery): boolean {
  const compactOpen = usePanelStore(selectIsCompactFileExplorerOpen);
  const paneOpen = useWorkspaceLayoutStore((state) =>
    input.isCompact ? false : isSidePanelOpenForLayout(state, input),
  );
  return input.isCompact ? compactOpen : paneOpen;
}

/** Imperative counterpart of {@link useIsSidePanelOpen}. */
export function isSidePanelOpen(input: SidePanelQuery): boolean {
  if (input.isCompact) {
    return selectIsCompactFileExplorerOpen(usePanelStore.getState());
  }
  return isSidePanelOpenForLayout(useWorkspaceLayoutStore.getState(), input);
}

function isSidePanelOpenForLayout(state: LayoutState, input: SidePanelQuery): boolean {
  if (!input.workspaceKey) {
    return false;
  }
  return canUseSidePanelPane(input)
    ? selectIsSidePanelVisible(state, input.workspaceKey)
    : findActiveSidePanelTabId(state, input.workspaceKey) !== null;
}
