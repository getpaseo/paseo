import { useCallback } from "react";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import {
  useSidebarWorkspacePinController,
  type PinnableWorkspace,
} from "@/hooks/use-sidebar-workspace-pin";
import { useSidebarBatchWorkspaceActions } from "@/hooks/use-sidebar-batch-actions";
import type { KeyboardActionId } from "@/keyboard/keyboard-action-dispatcher";
import { useHostFeature } from "@/runtime/host-features";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSidebarSelectionStore } from "@/stores/sidebar-selection-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

const WORKSPACE_PIN_ACTIONS: readonly KeyboardActionId[] = ["workspace.pin"];

// The pin shortcut used to live on the sidebar row, so it disappeared whenever the row was not
// rendered — a collapsed project or status group, a collapsed Pinned section, or focus mode.
// It belongs here instead: one registration keyed on the active route selection.
//
// "Active workspace" means the route selection, not a focused pane. Those are equivalent today
// (panes belong to the routed workspace, and /settings parses to no selection, which correctly
// disables the handler). Revisit this if panes ever span workspaces.
export function useGlobalWorkspacePinAction() {
  const selection = useActiveWorkspaceSelection();
  const serverId = selection?.serverId ?? null;
  const routeWorkspaceId = selection?.workspaceId ?? null;
  // Narrow projection so pin state changes don't re-render on every gitRuntime/diffStat tick.
  // A null result means the workspace is gone, which `pinnedAt: null` alone could not express.
  //
  // `id` is projected rather than reusing the route id: the route carries an opaque workspace id
  // that is not guaranteed to equal the descriptor id (that is why `selectWorkspace` resolves it
  // through `resolveWorkspaceMapKeyByIdentity`). The RPC and the in-flight key both need the
  // descriptor id, so that sidebar rows and this handler agree on one identity.
  const fields = useWorkspaceFields(serverId, routeWorkspaceId, (workspace) => ({
    id: workspace.id,
    pinnedAt: workspace.pinnedAt ?? null,
  }));
  const canPin = useHostFeature(serverId, "workspacePinning");
  const togglePin = useSidebarWorkspacePinController();
  const { pin: batchPin, unpin: batchUnpin } = useSidebarBatchWorkspaceActions();

  const handle = useCallback(() => {
    if (!serverId || !fields || !canPin) {
      return false;
    }
    const workspaceKey = buildWorkspaceTabPersistenceKey({
      serverId,
      workspaceId: fields.id,
    });
    if (!workspaceKey) {
      return false;
    }
    // When the active workspace sits inside a multi-selection, the shortcut propagates its own
    // toggle direction to the whole selection: whatever it would do to this row, it does to all.
    const selectionState = useSidebarSelectionStore.getState();
    if (selectionState.selected.length > 1 && selectionState.selectedKeys.has(workspaceKey)) {
      const targets: PinnableWorkspace[] = selectionState.selected.map((target) => ({
        serverId: target.serverId,
        workspaceId: target.workspaceId,
        workspaceKey: target.workspaceKey,
        pinnedAt: null,
      }));
      if (fields.pinnedAt == null) {
        batchPin(targets);
      } else {
        batchUnpin(targets);
      }
      return true;
    }
    togglePin({
      serverId,
      workspaceId: fields.id,
      workspaceKey,
      pinnedAt: fields.pinnedAt,
    });
    return true;
  }, [batchPin, batchUnpin, canPin, fields, serverId, togglePin]);

  useKeyboardActionHandler({
    handlerId: "workspace-pin-global",
    actions: WORKSPACE_PIN_ACTIONS,
    enabled: serverId !== null && fields !== null && canPin,
    priority: 0,
    handle,
  });
}
