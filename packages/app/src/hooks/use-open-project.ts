import { router } from "expo-router";
import { useCallback } from "react";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { normalizeWorkspaceDescriptor, useSessionStore } from "@/stores/session-store";
import { prepareWorkspaceTab } from "@/utils/workspace-navigation";

export function useOpenProject(serverId: string | null): (path: string) => Promise<boolean> {
  const normalizedServerId = serverId?.trim() ?? "";
  const toast = useToast();
  const client = useHostRuntimeClient(normalizedServerId);
  const mergeWorkspaces = useSessionStore((state) => state.mergeWorkspaces);
  const setHasHydratedWorkspaces = useSessionStore((state) => state.setHasHydratedWorkspaces);

  return useCallback(
    async (path: string) => {
      const trimmedPath = path.trim();
      if (!trimmedPath || !client || !normalizedServerId) {
        return false;
      }

      try {
        const payload = await client.openProject(trimmedPath);
        if (payload.error || !payload.workspace) {
          throw new Error(payload.error || "Failed to open project");
        }

        mergeWorkspaces(normalizedServerId, [normalizeWorkspaceDescriptor(payload.workspace)]);
        setHasHydratedWorkspaces(normalizedServerId, true);
        router.replace(
          prepareWorkspaceTab({
            serverId: normalizedServerId,
            workspaceId: payload.workspace.id,
            target: { kind: "draft", draftId: "new" },
          }) as any,
        );
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to open project");
        return false;
      }
    },
    [client, mergeWorkspaces, normalizedServerId, setHasHydratedWorkspaces, toast],
  );
}
