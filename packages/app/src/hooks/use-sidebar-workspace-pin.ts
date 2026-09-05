import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { useToast } from "@/contexts/toast-context";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import {
  planWorkspacePinMutation,
  type WorkspacePinAction,
} from "@/workspace-pin-groups/menu-model";

// Everything the pin toggle actually needs. Kept narrower than SidebarWorkspaceEntry so the
// global keyboard handler can build one from the active route selection without a sidebar row.
export type PinnableWorkspace = Pick<
  SidebarWorkspaceEntry,
  "serverId" | "workspaceId" | "workspaceKey" | "pinnedAt" | "pinGroupId"
>;

export type ToggleSidebarWorkspacePin = (
  workspace: PinnableWorkspace,
  action: WorkspacePinAction,
) => void;

// Module scope, not a per-hook ref: the sidebar row menus and the global keyboard shortcut each
// hold their own controller instance, and a per-instance guard would let a keypress and a menu
// click fire two concurrent, opposite pin-group membership calls for the same workspace.
const pendingWorkspaceKeys = new Set<string>();

export function useSidebarWorkspacePinController(): ToggleSidebarWorkspacePin {
  const { t } = useTranslation();
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: async (input: { workspace: PinnableWorkspace; groupId: string | null }) => {
      const { workspace } = input;
      const client = getHostRuntimeStore().getClient(workspace.serverId);
      if (!client) {
        throw new Error(t("sidebar.workspace.toasts.hostDisconnected"));
      }
      await client.setWorkspacePinGroup(workspace.workspaceId, input.groupId);
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : t("sidebar.workspace.toasts.hostDisconnected"),
      );
    },
    onSettled: (_data, _error, { workspace }) => {
      pendingWorkspaceKeys.delete(workspace.workspaceKey);
    },
  });
  const mutate = mutation.mutate;

  return useCallback(
    (workspace: PinnableWorkspace, action: WorkspacePinAction) => {
      if (pendingWorkspaceKeys.has(workspace.workspaceKey)) {
        return;
      }
      if (action.kind === "unavailable") {
        return;
      }
      if (action.kind === "update-host") {
        toast.error(t("sidebar.pinned.groups.updateHost"));
        return;
      }
      if (action.kind === "host-disconnected") {
        toast.error(t("sidebar.workspace.toasts.hostDisconnected"));
        return;
      }
      const plan = planWorkspacePinMutation({
        pinGroupId: workspace.pinGroupId,
        activeGroupId: action.selection.groupId,
      });
      pendingWorkspaceKeys.add(workspace.workspaceKey);
      mutate({ workspace, groupId: plan.groupId });
    },
    [mutate, t, toast],
  );
}
