import { useCallback } from "react";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { redirectIfArchivingActiveWorkspace } from "@/utils/sidebar-workspace-archive-redirect";
import { useWorkspaceArchive } from "@/workspace/use-workspace-archive";
import { isWorkspaceListed, type WorkspaceArchiveTarget } from "@/workspace/workspace-archive";

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

  // useWorkspaceArchive calls the latest render's callback, so `activeWorkspaceId` is whatever is
  // routed when the archive starts, after any confirmation. It is the descriptor id, which is what
  // the redirect compares against.
  const activeWorkspaceId = fields?.id ?? null;
  const redirectAfterArchive = useCallback(
    (workspace: WorkspaceArchiveTarget) => {
      redirectIfArchivingActiveWorkspace({
        ...workspace,
        activeWorkspaceSelection:
          serverId && activeWorkspaceId ? { serverId, workspaceId: activeWorkspaceId } : null,
      });
    },
    [activeWorkspaceId, serverId],
  );

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
