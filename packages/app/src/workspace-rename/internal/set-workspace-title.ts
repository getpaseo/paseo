import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

// The subset of a workspace a rename needs. Narrower than SidebarWorkspaceEntry so the command
// center can build one from the active route selection without a sidebar row.
export interface RenamableWorkspace {
  serverId: string;
  workspaceId: string;
  name: string;
  title?: string | null;
}

/** What the rename field starts with: the custom title, else the derived name it overrides. */
export function workspaceRenameInitialValue(workspace: RenamableWorkspace): string {
  return workspace.title ?? workspace.name;
}

/** Resolves to the title the daemon accepted; rejects with a displayable message. */
export function useSetWorkspaceTitle(
  workspace: Pick<RenamableWorkspace, "serverId" | "workspaceId">,
): (title: string) => Promise<string | null> {
  const { t } = useTranslation();
  const mutation = useMutation({
    mutationFn: async (title: string) => {
      const client = getHostRuntimeStore().getClient(workspace.serverId);
      if (!client) {
        throw new Error(t("sidebar.workspace.toasts.hostDisconnected"));
      }
      const trimmed = title.trim();
      const accepted = await client.setWorkspaceTitle(
        workspace.workspaceId,
        trimmed.length === 0 ? null : trimmed,
      );
      return accepted.title;
    },
  });
  return mutation.mutateAsync;
}
