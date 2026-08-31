import type { OpenInSidePanePreferences } from "@/hooks/use-settings";
import {
  collectAllTabs,
  collectAllPanes,
  DEFAULT_PANE_ID,
  findPaneById,
  useWorkspaceLayoutStore,
  type WorkspaceTabPlacement,
} from "@/stores/workspace-layout-store";
import { getPanelInstanceAttributes } from "@/panels/panel-instance-attributes";
import { workspaceTabTargetsEqual } from "@/workspace-tabs/identity";
import type {
  WorkspaceTab,
  WorkspaceTabOpenMode,
  WorkspaceTabTarget,
} from "@/workspace-tabs/model";

export type OpenInSidePaneSource = keyof OpenInSidePanePreferences;
export type WorkspaceTargetOpenLocation = "main" | "side";

interface OpenWorkspaceTargetInput {
  workspaceKey: string | null;
  target: WorkspaceTabTarget;
  parentTabId?: string | null;
}

export interface OpenPreferredWorkspaceTargetInput extends OpenWorkspaceTargetInput {
  isCompact: boolean;
  source: OpenInSidePaneSource;
  preferences: OpenInSidePanePreferences;
}

interface OpenWorkspaceTargetAtLocationInput extends OpenWorkspaceTargetInput {
  isCompact: boolean;
  location: WorkspaceTargetOpenLocation;
}

interface OpenPreferredWorkspacePreviewInput extends OpenPreferredWorkspaceTargetInput {
  serverId: string;
  workspaceId: string;
  explorerSidebarPaneId: string | null;
  lastMainPaneId: string | null;
  /** `"normal"` claims a tab of its own; `"preview"` reuses the destination pane's slot. */
  mode: WorkspaceTabOpenMode;
  /** When false, every open lands in a normal tab — the Settings → General switch is off. */
  previewEnabled: boolean;
}

function resolveMainPane(input: {
  workspaceKey: string;
  explorerSidebarPaneId: string | null;
  lastMainPaneId: string | null;
}) {
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[input.workspaceKey];
  if (!layout) return null;
  const panes = collectAllPanes(layout.root);
  return (
    panes.find(
      (pane) =>
        pane.id === input.lastMainPaneId &&
        pane.id !== input.explorerSidebarPaneId &&
        pane.hidden !== true,
    ) ??
    panes.find((pane) => pane.id === DEFAULT_PANE_ID && pane.hidden !== true) ??
    panes.find((pane) => pane.id !== input.explorerSidebarPaneId && pane.hidden !== true) ??
    null
  );
}

function canReplacePreview(input: {
  serverId: string;
  workspaceId: string;
  tab: WorkspaceTab;
  nextTarget: WorkspaceTabTarget;
}): boolean {
  if (input.tab.preview !== true) return false;
  // Editing a preview keeps it through usePublishPanelInstanceAttributes. This second check is the
  // safety net for the window before that effect runs: an unsaved buffer is never overwritten.
  if (
    getPanelInstanceAttributes({
      serverId: input.serverId,
      workspaceId: input.workspaceId,
      tabId: input.tab.tabId,
    }).modified
  ) {
    return false;
  }
  return input.nextTarget.kind === "file" && input.tab.target.kind === "file";
}

function findReusablePreviewTab(input: {
  serverId: string;
  workspaceId: string;
  paneTabs: WorkspaceTab[];
  nextTarget: WorkspaceTabTarget;
}): WorkspaceTab | null {
  // One preview per pane, so the first match is the slot to reuse. The focused tab is not a usable
  // stand-in: the user can focus a normal tab and leave the preview sitting beside it.
  return (
    input.paneTabs.find((tab) =>
      canReplacePreview({
        serverId: input.serverId,
        workspaceId: input.workspaceId,
        tab,
        nextTarget: input.nextTarget,
      }),
    ) ?? null
  );
}

/** Opens an implicit target according to its source-specific desktop preference. */
export function openPreferredWorkspaceTarget(
  input: OpenPreferredWorkspaceTargetInput,
): string | null {
  return openWorkspaceTargetAtLocation({
    isCompact: input.isCompact,
    workspaceKey: input.workspaceKey,
    target: input.target,
    location: input.preferences[input.source] ? "side" : "main",
    parentTabId: input.parentTabId,
  });
}

/** Opens an implicit target at the user's preferred main or side location. */
export function openWorkspaceTargetAtLocation(
  input: OpenWorkspaceTargetAtLocationInput,
): string | null {
  if (!input.workspaceKey) return null;
  const store = useWorkspaceLayoutStore.getState();
  const layout = store.layoutByWorkspace[input.workspaceKey];
  const targetAlreadyExists = Boolean(
    layout &&
    collectAllTabs(layout.root).some((tab) => workspaceTabTargetsEqual(tab.target, input.target)),
  );
  const shouldOpenBeside = !input.isCompact && input.location === "side";
  let placement: WorkspaceTabPlacement | undefined;
  if (shouldOpenBeside && !targetAlreadyExists) {
    const paneId = store.ensureSidePane(input.workspaceKey);
    placement = paneId ? { mode: "prefer", paneId } : undefined;
  }
  return store.openTab({
    workspaceKey: input.workspaceKey,
    target: input.target,
    intent: "reveal",
    placement,
    parentTabId: input.parentTabId ?? undefined,
  });
}

/** Opens a tree selection into the destination pane's preview slot, or into a normal tab beside the rest. */
export function openPreferredWorkspacePreview(
  input: OpenPreferredWorkspacePreviewInput,
): string | null {
  if (!input.workspaceKey) return null;
  const store = useWorkspaceLayoutStore.getState();
  const layout = store.layoutByWorkspace[input.workspaceKey];
  if (!layout) return null;
  const existing = collectAllTabs(layout.root).find((tab) =>
    workspaceTabTargetsEqual(tab.target, input.target),
  );
  if (existing) {
    // Double-clicking a file that is already previewing is how the user keeps it, so promote in
    // place. Every other open of an already-open target just moves focus.
    if (input.mode === "normal" && existing.preview === true) {
      store.setTabPreview(input.workspaceKey, existing.tabId, false);
    }
    return openPreferredWorkspaceTarget(input);
  }
  if (!input.previewEnabled || input.mode === "normal") {
    return openPreferredWorkspaceTarget(input);
  }
  // A preview tab is claimed by an Explorer single click and by nothing else. Every source shares
  // the destination logic below, but a preview is not persisted, so tagging one here for Changes or
  // a diff file tree would silently make those tabs vanish on reload.
  const claimsPreviewSlot = input.source === "explorerFiles";

  const mainPane = resolveMainPane({
    workspaceKey: input.workspaceKey,
    explorerSidebarPaneId: input.explorerSidebarPaneId,
    lastMainPaneId: input.lastMainPaneId,
  });
  const destinationPaneId =
    !input.isCompact && input.preferences[input.source]
      ? store.ensureSidePane(input.workspaceKey)
      : mainPane?.id;
  if (!destinationPaneId) return null;
  const nextLayout = useWorkspaceLayoutStore.getState().layoutByWorkspace[input.workspaceKey];
  const destinationPane = nextLayout ? findPaneById(nextLayout.root, destinationPaneId) : null;
  const paneTabs = nextLayout
    ? collectAllTabs(nextLayout.root).filter((tab) =>
        (destinationPane?.tabIds ?? []).includes(tab.tabId),
      )
    : [];
  const previewTab = claimsPreviewSlot
    ? findReusablePreviewTab({
        serverId: input.serverId,
        workspaceId: input.workspaceId,
        paneTabs,
        nextTarget: input.target,
      })
    : null;
  if (previewTab) {
    // replaceTab keeps the tab id for a same-kind swap, so the chip stays the same DOM node and
    // the mounted panel takes new props instead of remounting.
    return store.replaceTab(input.workspaceKey, previewTab.tabId, input.target);
  }
  const activeTab = paneTabs.find((tab) => tab.tabId === destinationPane?.focusedTabId) ?? null;
  return store.openTab({
    workspaceKey: input.workspaceKey,
    target: input.target,
    intent: "reveal",
    placement: { mode: "pane", paneId: destinationPaneId },
    parentTabId: input.parentTabId ?? activeTab?.tabId ?? undefined,
    preview: claimsPreviewSlot,
  });
}

/** Explicit Open to Side: creates the side pane and places the target there. */
export function openWorkspaceTargetBeside(input: OpenWorkspaceTargetInput): string | null {
  if (!input.workspaceKey) return null;
  const store = useWorkspaceLayoutStore.getState();
  const paneId = store.ensureSidePane(input.workspaceKey);
  return store.openTab({
    workspaceKey: input.workspaceKey,
    target: input.target,
    intent: "reveal",
    placement: paneId ? { mode: "pane", paneId } : undefined,
    parentTabId: input.parentTabId ?? undefined,
  });
}
