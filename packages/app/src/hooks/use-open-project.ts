import { useCallback } from "react";
import { router } from "expo-router";
import type { DaemonClient } from "@server/client/daemon-client";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import {
  normalizeWorkspaceDescriptor,
  type WorkspaceDescriptor,
  useSessionStore,
} from "@/stores/session-store";
import {
  buildWorkspaceTabPersistenceKey,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { generateDraftId } from "@/stores/draft-keys";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";

interface OpenProjectDirectlyInput {
  serverId: string;
  projectPath: string;
  isConnected: boolean;
  client: Pick<DaemonClient, "openProject"> | null;
  mergeWorkspaces: (serverId: string, workspaces: Iterable<WorkspaceDescriptor>) => void;
  setHasHydratedWorkspaces: (serverId: string, hydrated: boolean) => void;
  openDraftTab: (workspaceKey: string) => string | null;
  replaceRoute: (route: string) => void;
}

export async function openProjectDirectly(input: OpenProjectDirectlyInput): Promise<boolean> {
  const normalizedServerId = input.serverId.trim();
  const trimmedPath = input.projectPath.trim();
  if (!normalizedServerId || !trimmedPath || !input.client || !input.isConnected) {
    return false;
  }

  const payload = await input.client.openProject(trimmedPath);
  if (payload.error || !payload.workspace) {
    return false;
  }

  const workspace = normalizeWorkspaceDescriptor(payload.workspace);
  input.mergeWorkspaces(normalizedServerId, [workspace]);
  input.setHasHydratedWorkspaces(normalizedServerId, true);

  const workspaceKey = buildWorkspaceTabPersistenceKey({
    serverId: normalizedServerId,
    workspaceId: workspace.id,
  });
  if (!workspaceKey) {
    return false;
  }

  input.openDraftTab(workspaceKey);
  input.replaceRoute(buildHostWorkspaceRoute(normalizedServerId, workspace.id));
  return true;
}

export function useOpenProject(serverId: string | null): (path: string) => Promise<boolean> {
  const normalizedServerId = serverId?.trim() ?? "";
  const client = useHostRuntimeClient(normalizedServerId);
  const isConnected = useHostRuntimeIsConnected(normalizedServerId);
  const mergeWorkspaces = useSessionStore((state) => state.mergeWorkspaces);
  const setHasHydratedWorkspaces = useSessionStore((state) => state.setHasHydratedWorkspaces);

  return useCallback(
    async (path: string) => {
      return openProjectDirectly({
        serverId: normalizedServerId,
        projectPath: path,
        isConnected,
        client,
        mergeWorkspaces,
        setHasHydratedWorkspaces,
        openDraftTab: (workspaceKey: string) =>
          useWorkspaceLayoutStore.getState().openTabFocused(workspaceKey, {
            kind: "draft",
            draftId: generateDraftId(),
          }),
        replaceRoute: (route) => {
          router.replace(route as any);
        },
      });
    },
    [client, isConnected, mergeWorkspaces, normalizedServerId, setHasHydratedWorkspaces],
  );
}
