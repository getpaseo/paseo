import { useCallback } from "react";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { KeyboardActionId } from "@/keyboard/keyboard-action-dispatcher";
import { useHostFeature } from "@/runtime/host-features";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { usePanelStore } from "@/stores/panel-store";
import { buildWorkspaceExplorerStateKey } from "@/hooks/use-file-explorer-actions";

const FILE_SEARCH_ACTIONS: readonly KeyboardActionId[] = ["file.search"];

// Ctrl/Cmd+L opens the content-search panel of the ACTIVE workspace's file
// explorer. Registered globally (like useGlobalWorkspacePinAction) so the
// shortcut works regardless of which surface currently owns focus — the panel
// store carries the open flag the explorer pane reads.
export function useGlobalFileSearchAction() {
  const selection = useActiveWorkspaceSelection();
  const serverId = selection?.serverId ?? null;
  const workspaceId = selection?.workspaceId ?? null;
  // COMPAT(fsContentSearch): added in v0.3.2, remove gate after 2027-08-11.
  const supportsContentSearch = useHostFeature(serverId, "fsContentSearch");
  const openContentSearch = usePanelStore((state) => state.openContentSearch);

  const handle = useCallback(() => {
    if (!serverId || !workspaceId || !supportsContentSearch) {
      return false;
    }
    const workspaceStateKey = buildWorkspaceExplorerStateKey({ workspaceId });
    if (!workspaceStateKey) {
      return false;
    }
    openContentSearch(workspaceStateKey);
    return true;
  }, [openContentSearch, serverId, supportsContentSearch, workspaceId]);

  useKeyboardActionHandler({
    handlerId: "global-file-search",
    actions: FILE_SEARCH_ACTIONS,
    enabled: true,
    priority: 0,
    handle,
  });
}
