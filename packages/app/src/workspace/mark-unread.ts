import { i18n } from "@/i18n/i18next";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { focusWorkspaceTabEphemerally } from "@/stores/workspace-layout-actions";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";

export async function markWorkspaceUnread(serverId: string, workspaceId: string): Promise<void> {
  const client = getHostRuntimeStore().getClient(serverId);
  if (!client) {
    throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
  }

  const workspaceKey = `${serverId}:${workspaceId}`;
  const store = useWorkspaceLayoutStore.getState();
  // End viewing before restoring attention. The next pane focus reads it normally;
  // leaving the workspace must not consume the mark the user just made. Gate on
  // the effective layout — during an attention reveal the pane on screen is the
  // revealed one, not the persisted focus the suspension would otherwise miss.
  const persistedLayout = store.layoutByWorkspace[workspaceKey];
  const ephemeralFocusTarget = store.ephemeralFocusTargetByWorkspace[workspaceKey];
  const effectiveLayout =
    persistedLayout && ephemeralFocusTarget
      ? focusWorkspaceTabEphemerally({ layout: persistedLayout, target: ephemeralFocusTarget })
      : (persistedLayout ?? null);
  const focusToken = effectiveLayout?.focusedPaneId ? store.unfocusPane(workspaceKey) : null;
  try {
    await client.markWorkspaceUnread(workspaceId);
  } catch (error) {
    if (focusToken) {
      store.restorePaneFocus(workspaceKey, focusToken);
    }
    throw error;
  }
}
