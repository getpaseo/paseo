import type { TerminalOpenLocation } from "@/hooks/use-settings";
import type { TerminalTabDestination } from "@/screens/workspace/terminals/use-workspace-terminals";
import {
  collectAllTabs,
  findPaneById,
  useWorkspaceLayoutStore,
  type WorkspaceTabPlacement,
} from "@/stores/workspace-layout-store";

interface ResolveImplicitTerminalPlacementInput {
  isCompact: boolean;
  supportsPaneSplits: boolean;
  persistenceKey: string | null;
  location: TerminalOpenLocation;
  destination: TerminalTabDestination;
}

/**
 * Where an implicitly opened terminal lands, per the Open location preference.
 * An explicit pane target always wins; every other non-desktop context falls back
 * to the focused pane, which callers apply when this returns undefined.
 */
export function resolveImplicitTerminalPlacement(
  input: ResolveImplicitTerminalPlacementInput,
): Extract<WorkspaceTabPlacement, { mode: "pane" | "prefer" }> | undefined {
  if (
    input.isCompact ||
    !input.supportsPaneSplits ||
    !input.persistenceKey ||
    input.destination.kind !== "open" ||
    input.destination.paneId
  ) {
    return undefined;
  }
  const store = useWorkspaceLayoutStore.getState();
  if (input.location === "bottom") {
    const paneId = store.ensureBottomPane(input.persistenceKey);
    return paneId ? { mode: "prefer", paneId } : undefined;
  }
  if (input.location === "side") {
    const paneId = store.ensureSidePane(input.persistenceKey);
    return paneId ? { mode: "prefer", paneId } : undefined;
  }
  return undefined;
}

/**
 * Lands a freshly created terminal tab at the resolved pane.
 *
 * The daemon's terminal list can reach the reconcile effect before the start callback runs,
 * in which case the tab was already created in the focused pane. Swapping contents with the
 * destination pane's New tab placeholder keeps both panes intact while the terminal still
 * ends up where the preference wants it; without a stray tab, the plain reveal path applies.
 */
export function placeTerminalTabInPane(input: {
  workspaceKey: string;
  placement: Extract<WorkspaceTabPlacement, { mode: "pane" | "prefer" }>;
  terminalId: string;
}): void {
  const store = useWorkspaceLayoutStore.getState();
  const layout = store.layoutByWorkspace[input.workspaceKey];
  if (!layout) {
    return;
  }

  const targetPane = findPaneById(layout.root, input.placement.paneId);
  const tabsById = new Map(collectAllTabs(layout.root).map((tab) => [tab.tabId, tab]));
  const placeholder = targetPane?.tabIds
    .map((tabId) => tabsById.get(tabId))
    .find((tab) => tab?.target.kind === "new_tab");
  const existing = collectAllTabs(layout.root).find(
    (tab) => tab.target.kind === "terminal" && tab.target.terminalId === input.terminalId,
  );
  if (!existing || !placeholder || existing.tabId === placeholder.tabId) {
    store.openTab({
      workspaceKey: input.workspaceKey,
      target: { kind: "terminal", terminalId: input.terminalId },
      intent: "reveal",
      placement: input.placement,
    });
    return;
  }

  store.replaceTab(input.workspaceKey, existing.tabId, { kind: "new_tab" });
  store.replaceTab(input.workspaceKey, placeholder.tabId, {
    kind: "terminal",
    terminalId: input.terminalId,
  });
  store.focusTab(input.workspaceKey, placeholder.tabId);
}
