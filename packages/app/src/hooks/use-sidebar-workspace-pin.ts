import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { useToast } from "@/contexts/toast-context";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

export type ToggleSidebarWorkspacePin = (workspace: SidebarWorkspaceEntry) => void;

export function useSidebarWorkspacePinController(): ToggleSidebarWorkspacePin {
  const { t } = useTranslation();
  const toast = useToast();
  const pendingWorkspaceKeysRef = useRef(new Set<string>());
  const mutation = useMutation({
    mutationFn: async ({
      workspace,
      pinned,
    }: {
      workspace: SidebarWorkspaceEntry;
      pinned: boolean;
    }) => {
      const client = getHostRuntimeStore().getClient(workspace.serverId);
      if (!client) {
        throw new Error(t("sidebar.workspace.toasts.hostDisconnected"));
      }
      await client.setWorkspacePinned(workspace.workspaceId, pinned);
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : t("sidebar.workspace.toasts.hostDisconnected"),
      );
    },
    onSettled: (_data, _error, { workspace }) => {
      pendingWorkspaceKeysRef.current.delete(workspace.workspaceKey);
    },
  });
  const mutate = mutation.mutate;

  return useCallback(
    (workspace: SidebarWorkspaceEntry) => {
      if (pendingWorkspaceKeysRef.current.has(workspace.workspaceKey)) {
        return;
      }
      pendingWorkspaceKeysRef.current.add(workspace.workspaceKey);
      mutate({ workspace, pinned: workspace.pinnedAt == null });
    },
    [mutate],
  );
}
