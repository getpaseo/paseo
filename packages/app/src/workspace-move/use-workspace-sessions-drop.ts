import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { flashLandedWorkspace, type WorkspaceDropTarget } from "./drop-target";
import { describeMove, moveWorkspaceSessions } from "./move-sessions";

/** Dragging a workspace onto another project's workspace moves its sessions there. */
export function useWorkspaceSessionsDrop(ownWorkspaceIds: readonly string[] = []) {
  const { t } = useTranslation();
  const toast = useToast();
  return useCallback(
    (item: { serverId: string; workspaceId: string }, target: WorkspaceDropTarget) => {
      if (target.workspaceId === item.workspaceId || ownWorkspaceIds.includes(target.workspaceId)) {
        return false;
      }
      if (target.serverId !== item.serverId) {
        toast.error(t("sidebar.project.toasts.moveAcrossHosts"));
        return true;
      }
      const names = describeMove({
        serverId: item.serverId,
        agentId: null,
        targetWorkspaceId: target.workspaceId,
      });
      void moveWorkspaceSessions({
        serverId: item.serverId,
        sourceWorkspaceId: item.workspaceId,
        targetWorkspaceId: target.workspaceId,
      })
        .then((result) => {
          flashLandedWorkspace(target);
          return toast.show(
            t("sidebar.project.toasts.sessionsMovedTo", {
              count: result.moved,
              workspace: names.workspace,
            }),
          );
        })
        .catch(() => toast.error(t("sidebar.project.toasts.moveSessionsFailed")));
      return true;
    },
    [ownWorkspaceIds, t, toast],
  );
}
