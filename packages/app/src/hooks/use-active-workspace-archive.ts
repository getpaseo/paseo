import { useCallback } from "react";
import {
  useActiveWorkspaceSelection,
  type ActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { getFocusedWorkspaceSelection } from "@/navigation/workspace-route-navigation";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { redirectIfArchivingActiveWorkspace } from "@/utils/sidebar-workspace-archive-redirect";
import { useWorkspaceArchive } from "@/workspace/use-workspace-archive";
import { isWorkspaceListed, type WorkspaceArchiveTarget } from "@/workspace/workspace-archive";

// The redirect compares descriptor ids; the route's id is not guaranteed to equal one (see
// use-global-workspace-pin-action.ts), so resolve it through the session store.
function readActiveDescriptorSelection(): ActiveWorkspaceSelection | null {
  const selection = getFocusedWorkspaceSelection();
  if (!selection) {
    return null;
  }
  const workspaces = useSessionStore.getState().sessions[selection.serverId]?.workspaces;
  const key = resolveWorkspaceMapKeyByIdentity({
    workspaces,
    workspaceId: selection.workspaceId,
  });
  const descriptor = key ? workspaces?.get(key) : undefined;
  return descriptor ? { serverId: selection.serverId, workspaceId: descriptor.id } : null;
}

export interface ActiveWorkspaceArchive {
  /** False when no workspace is routed, or the routed one is already archiving. */
  canArchive: boolean;
  /** Starts the archive for the routed workspace. Returns false when nothing was started. */
  archive: () => boolean;
}

/**
 * Archives the workspace the route points at. Keyed on the route selection rather than a rendered
 * row, so it works from the keyboard shortcut and from the compact header menu alike.
 */
export function useActiveWorkspaceArchive(): ActiveWorkspaceArchive {
  const selection = useActiveWorkspaceSelection();
  const serverId = selection?.serverId ?? null;
  const routeWorkspaceId = selection?.workspaceId ?? null;
  // `id` is the descriptor id, not the route id; see use-global-workspace-pin-action.ts.
  const fields = useWorkspaceFields(serverId, routeWorkspaceId, (workspace) => ({
    id: workspace.id,
    workspaceKind: workspace.workspaceKind,
    workspaceDirectory: workspace.workspaceDirectory,
    name: workspace.name,
    archivingAt: workspace.archivingAt,
    diffStat: workspace.diffStat,
  }));

  // The archive starts after the host answers and you confirm, by which time the header that began
  // it may be gone (a resize swaps it, and on native switching workspaces unmounts it), and you may
  // have left workspace routes. So the redirect reads the focused route now, not this render's.
  const redirectAfterArchive = useCallback((workspace: WorkspaceArchiveTarget) => {
    redirectIfArchivingActiveWorkspace({
      ...workspace,
      activeWorkspaceSelection: readActiveDescriptorSelection(),
    });
  }, []);

  const archiveController = useWorkspaceArchive({
    serverId: serverId ?? "",
    workspaceId: fields?.id ?? "",
    workspaceKind: fields?.workspaceKind ?? "directory",
    workspaceDirectory: fields?.workspaceDirectory ?? "",
    name: fields?.name ?? "",
    diffStat: fields?.diffStat,
    onArchiveStarted: redirectAfterArchive,
  });

  const canArchive = fields !== null && fields.archivingAt === null;

  const archive = useCallback(() => {
    if (!canArchive || !serverId) {
      return false;
    }
    // Archiving hides its target immediately. Read the store in case this runs again before
    // React renders that update.
    if (!isWorkspaceListed({ serverId, workspaceId: fields.id })) {
      return false;
    }
    archiveController.archive();
    return true;
  }, [archiveController, canArchive, fields, serverId]);

  return { canArchive, archive };
}
