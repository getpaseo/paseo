import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { useToast } from "@/contexts/toast-context";
import { planPinnedSidebarReorder, type PinnedSidebarGroups } from "@/hooks/use-sidebar-pins";
import type {
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { mergeWithRemainder } from "@/utils/sidebar-reorder";

// Everything the pin toggle actually needs. Kept narrower than SidebarWorkspaceEntry so the
// global keyboard handler can build one from the active route selection without a sidebar row.
export type PinnableWorkspace = Pick<
  SidebarWorkspaceEntry,
  "serverId" | "workspaceId" | "workspaceKey" | "pinnedAt"
>;

export type ToggleSidebarWorkspacePin = (workspace: PinnableWorkspace) => void;

// Module scope, not a per-hook ref: the sidebar row menus and the global keyboard shortcut each
// hold their own controller instance, and a per-instance guard would let a keypress and a menu
// click fire two concurrent, opposite setWorkspacePinned calls for the same workspace.
const pendingWorkspaceKeys = new Set<string>();

export function useSidebarWorkspacePinController(): ToggleSidebarWorkspacePin {
  const { t } = useTranslation();
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: async ({
      workspace,
      pinned,
    }: {
      workspace: PinnableWorkspace;
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
      pendingWorkspaceKeys.delete(workspace.workspaceKey);
    },
  });
  const mutate = mutation.mutate;

  return useCallback(
    (workspace: PinnableWorkspace) => {
      if (pendingWorkspaceKeys.has(workspace.workspaceKey)) {
        return;
      }
      pendingWorkspaceKeys.add(workspace.workspaceKey);
      mutate({ workspace, pinned: workspace.pinnedAt == null });
    },
    [mutate],
  );
}

export function usePinnedWorkspaceReorder(pins: PinnedSidebarGroups) {
  const { t } = useTranslation();
  const toast = useToast();

  return useCallback(
    (reordered: SidebarWorkspacePlacement[]) => {
      const { getPinnedWorkspaceOrder, setPinnedWorkspaceOrder } = useSidebarOrderStore.getState();
      for (const [serverId, workspaces] of planPinnedSidebarReorder(pins, reordered)) {
        const localOrder = getPinnedWorkspaceOrder();
        if (serverId === null) {
          setPinnedWorkspaceOrder(
            mergeWithRemainder({
              currentOrder: localOrder,
              reorderedVisibleKeys: workspaces.map((workspace) => workspace.workspaceKey),
            }),
          );
          continue;
        }

        const client = getHostRuntimeStore().getClient(serverId);
        if (!client) {
          toast.error(t("sidebar.workspace.toasts.hostDisconnected"));
          continue;
        }

        const workspaceIds = workspaces.map((workspace) => workspace.workspaceId);
        const knownWorkspaces = useSessionStore.getState().sessions[serverId]?.workspaces;
        const knownPins = [...(knownWorkspaces?.values() ?? [])].filter(
          (workspace) => workspace.pinnedAt,
        );
        let legacyWorkspaceIds: string[] | undefined;
        if (!knownPins.some((workspace) => workspace.pinnedOrder !== undefined)) {
          const idByKey = new Map(knownPins.map(({ id }) => [serverId + ":" + id, id]));
          const legacyIds = localOrder.flatMap((key) => {
            const id = idByKey.get(key);
            return id === undefined ? [] : [id];
          });
          if (legacyIds.length > 0) legacyWorkspaceIds = legacyIds;
        }

        void client.setWorkspacePinnedOrder(workspaceIds, legacyWorkspaceIds).catch((error) => {
          toast.error(
            error instanceof Error ? error.message : t("sidebar.workspace.toasts.hostDisconnected"),
          );
        });
      }
    },
    [pins, t, toast],
  );
}
