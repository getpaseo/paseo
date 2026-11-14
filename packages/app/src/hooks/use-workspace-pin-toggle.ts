import { useCallback, useMemo } from "react";
import { useSidebarWorkspacePinController } from "@/hooks/use-sidebar-workspace-pin";
import { useHostFeature } from "@/runtime/host-features";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

export interface WorkspacePinToggle {
  isPinned: boolean;
  toggle: () => void;
}

// One workspace's pin state and toggle, for surfaces that act on a workspace without a sidebar
// row: the global pin shortcut and the workspace header menu. Null when the host can't pin or the
// workspace is gone, so callers hide or disable the action.
export function useWorkspacePinToggle(
  serverId: string | null,
  workspaceId: string | null,
): WorkspacePinToggle | null {
  // Narrow projection so pin state changes don't re-render on every gitRuntime/diffStat tick.
  // A null result means the workspace is gone, which `pinnedAt: null` alone could not express.
  //
  // `id` is projected rather than reusing the caller's id: a route carries an opaque workspace id
  // that is not guaranteed to equal the descriptor id (that is why `selectWorkspace` resolves it
  // through `resolveWorkspaceMapKeyByIdentity`). The RPC and the in-flight key both need the
  // descriptor id, so that sidebar rows and these surfaces agree on one identity.
  const fields = useWorkspaceFields(serverId, workspaceId, (workspace) => ({
    id: workspace.id,
    pinnedAt: workspace.pinnedAt ?? null,
  }));
  const canPin = useHostFeature(serverId, "workspacePinning");
  const togglePin = useSidebarWorkspacePinController();

  const workspaceKey =
    serverId && fields
      ? buildWorkspaceTabPersistenceKey({ serverId, workspaceId: fields.id })
      : null;
  const descriptorId = fields?.id ?? null;
  const pinnedAt = fields?.pinnedAt ?? null;

  const toggle = useCallback(() => {
    if (!serverId || !descriptorId || !workspaceKey) {
      return;
    }
    togglePin({ serverId, workspaceId: descriptorId, workspaceKey, pinnedAt });
  }, [descriptorId, pinnedAt, serverId, togglePin, workspaceKey]);

  const available = canPin && workspaceKey !== null;
  const isPinned = pinnedAt != null;
  return useMemo(() => (available ? { isPinned, toggle } : null), [available, isPinned, toggle]);
}
