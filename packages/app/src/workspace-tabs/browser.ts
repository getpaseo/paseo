import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { createWorkspaceBrowser, getBrowserRecord, useBrowserStore } from "@/desktop/browser/store";
import { useSessionStore } from "@/stores/session-store";
import {
  collectAllPanes,
  collectAllTabs,
  createWorkspaceLayoutWithExplorerSidebar,
  findPaneById,
  findPaneContainingTab,
  useWorkspaceLayoutStore,
  type WorkspaceTabPlacement,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-store";
import type { WorkspaceTabInsertionPosition } from "@/stores/workspace-layout-actions";
import { panelTargetSupportsHostForWorkspaceKey } from "@/plugins/workspace-panels/locations";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { buildWorkspaceTabPersistenceKey, type WorkspaceTab } from "@/workspace-tabs/model";

export interface OpenWorkspaceBrowserInput {
  workspaceKey: string;
  url?: string;
  browserId?: string;
  intent: "reveal" | "background";
  placement?: WorkspaceTabPlacement;
  insertionPosition?: WorkspaceTabInsertionPosition;
  parentTabId?: string;
  state?: JsonValue;
  replaceTabId?: string;
}

export type OpenWorkspaceBrowserResult =
  | { ok: true; tabId: string; browserId: string; created: boolean }
  | { ok: false; code: "workspace_unavailable" | "placement_unavailable" | "browser_unavailable" };

function resolveBrowserWorkspaceKey(workspaceKey: string): string | null {
  for (const [serverId, session] of Object.entries(useSessionStore.getState().sessions)) {
    for (const [mapKey, descriptor] of session.workspaces) {
      const matchesMapKey =
        buildWorkspaceTabPersistenceKey({ serverId, workspaceId: mapKey }) === workspaceKey;
      const matchesId =
        buildWorkspaceTabPersistenceKey({ serverId, workspaceId: descriptor.id }) === workspaceKey;
      if (!matchesMapKey && !matchesId) continue;
      const workspaceId = resolveWorkspaceMapKeyByIdentity({
        workspaces: session.workspaces,
        workspaceId: descriptor.id,
      });
      if (workspaceId) return buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
    }
  }
  return null;
}

interface BrowserOpenContext {
  workspaceKey: string;
  layout: WorkspaceLayout;
  existing: WorkspaceTab | null;
  explorerPaneId: string;
}

function supportsBrowserPane(context: BrowserOpenContext, paneId: string): boolean {
  return panelTargetSupportsHostForWorkspaceKey(
    context.workspaceKey,
    { kind: "browser", browserId: "pending" },
    paneId === context.explorerPaneId ? "explorer" : "main",
  );
}

function resolveBrowserReplacement(
  input: OpenWorkspaceBrowserInput,
  context: BrowserOpenContext,
): WorkspaceTabPlacement | null {
  if (input.browserId !== undefined || input.intent !== "reveal") return null;
  const launcher = collectAllTabs(context.layout.root).find(
    (tab) => tab.tabId === input.replaceTabId,
  );
  if (launcher?.target.kind !== "new_tab") return null;
  const pane = findPaneContainingTab(context.layout.root, launcher.tabId);
  if (!pane || !supportsBrowserPane(context, pane.id)) return null;
  const placement = input.placement;
  if (placement?.mode === "pane" || placement?.mode === "prefer") {
    if (placement.paneId !== pane.id) return null;
  }
  return { mode: "pane", paneId: pane.id };
}

function resolveExplicitBrowserPlacement(
  input: OpenWorkspaceBrowserInput,
  context: BrowserOpenContext,
  placement: Extract<WorkspaceTabPlacement, { mode: "pane" | "prefer" }>,
): WorkspaceTabPlacement | null {
  const pane = findPaneById(context.layout.root, placement.paneId);
  if (!pane || !supportsBrowserPane(context, pane.id)) return null;
  if (!context.existing || placement.mode === "prefer") return placement;
  const sourcePane = findPaneContainingTab(context.layout.root, context.existing.tabId);
  const movesExisting = sourcePane?.id !== pane.id;
  if (movesExisting && (pane.hidden === true || input.intent === "background")) return null;
  return placement;
}

function resolveBrowserPlacement(
  input: OpenWorkspaceBrowserInput,
  context: BrowserOpenContext,
): WorkspaceTabPlacement | null {
  if (input.replaceTabId !== undefined) return resolveBrowserReplacement(input, context);
  const placement = input.placement;
  if (placement?.mode === "pane" || placement?.mode === "prefer") {
    return resolveExplicitBrowserPlacement(input, context, placement);
  }
  if (context.existing) return placement ?? { mode: "ambient" };
  if (!placement) {
    const paneId = useWorkspaceLayoutStore
      .getState()
      .ensureBrowserPane(context.workspaceKey, { reveal: input.intent === "reveal" });
    return paneId ? { mode: "pane", paneId } : null;
  }
  const focused = findPaneById(context.layout.root, context.layout.focusedPaneId);
  const canUseFocused =
    focused && focused.hidden !== true && supportsBrowserPane(context, focused.id);
  const destination = canUseFocused
    ? focused
    : collectAllPanes(context.layout.root).find((pane) => supportsBrowserPane(context, pane.id));
  return destination ? { mode: "pane", paneId: destination.id } : null;
}

/** Opens only within a known workspace; explicit placement must never fall back elsewhere. */
export function openWorkspaceBrowser(input: OpenWorkspaceBrowserInput): OpenWorkspaceBrowserResult {
  const workspaceKey = resolveBrowserWorkspaceKey(input.workspaceKey.trim());
  if (!workspaceKey) return { ok: false, code: "workspace_unavailable" };
  const store = useWorkspaceLayoutStore.getState();
  const layout =
    store.layoutByWorkspace[workspaceKey] ?? createWorkspaceLayoutWithExplorerSidebar();
  const hasBrowserId = input.browserId !== undefined;
  const existing =
    collectAllTabs(layout.root).find(
      (tab) => tab.target.kind === "browser" && tab.target.browserId === input.browserId,
    ) ?? null;
  if (hasBrowserId && (!existing || !getBrowserRecord(input.browserId!))) {
    return { ok: false, code: "browser_unavailable" };
  }
  const placement = resolveBrowserPlacement(input, {
    workspaceKey,
    layout,
    existing,
    explorerPaneId: store.explorerSidebarPaneIdByWorkspace[workspaceKey] ?? "explorer",
  });
  if (!placement) return { ok: false, code: "placement_unavailable" };
  const browserId = input.browserId ?? createWorkspaceBrowser({ initialUrl: input.url }).browserId;
  let tabId: string | null;
  try {
    tabId =
      input.replaceTabId !== undefined
        ? store.replaceTab(
            workspaceKey,
            input.replaceTabId,
            { kind: "browser", browserId },
            input.state,
          )
        : store.openTab({
            ...input,
            workspaceKey,
            target: { kind: "browser", browserId },
            placement,
          });
  } catch (error) {
    if (!hasBrowserId) useBrowserStore.getState().removeBrowser(browserId);
    throw error;
  }
  if (!tabId) {
    if (!hasBrowserId) useBrowserStore.getState().removeBrowser(browserId);
    return { ok: false, code: "placement_unavailable" };
  }
  if (input.intent === "reveal") store.focusTab(workspaceKey, tabId);
  return { ok: true, tabId, browserId, created: !hasBrowserId };
}
