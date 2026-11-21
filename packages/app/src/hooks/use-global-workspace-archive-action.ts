import { useCallback } from "react";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { KeyboardActionId } from "@/keyboard/keyboard-action-dispatcher";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { redirectIfArchivingActiveWorkspace } from "@/utils/sidebar-workspace-archive-redirect";
import { useWorkspaceArchive } from "@/workspace/use-workspace-archive";
import { isWorkspaceListed, type WorkspaceArchiveTarget } from "@/workspace/workspace-archive";

const WORKSPACE_ARCHIVE_ACTIONS: readonly KeyboardActionId[] = ["workspace.archive"];

// The archive shortcut used to live on the sidebar row, so it did nothing whenever the row was not
// rendered — a collapsed project or status group, a collapsed Pinned section, or focus mode. Like
// the pin shortcut (see use-global-workspace-pin-action.ts), it is one registration keyed on the
// active route selection.
export function useGlobalWorkspaceArchiveAction() {
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

  const handle = useCallback(() => {
    if (!canArchive || !serverId) {
      return false;
    }
    // Archiving hides its target immediately. Read the store in case the shortcut
    // runs again before React renders that update.
    if (!isWorkspaceListed({ serverId, workspaceId: fields.id })) {
      return false;
    }
    archiveController.archive();
    return true;
  }, [archiveController, canArchive, fields, serverId]);

  useKeyboardActionHandler({
    handlerId: "workspace-archive-global",
    actions: WORKSPACE_ARCHIVE_ACTIONS,
    enabled: canArchive,
    priority: 0,
    handle,
  });
}
