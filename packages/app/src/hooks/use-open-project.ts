import { router } from "expo-router";
import { useCallback } from "react";
import type { DaemonClient } from "@server/client/daemon-client";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import {
  normalizeWorkspaceDescriptor,
  useSessionStore,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import { useActiveOrgId } from "@/stores/active-org-store";
import { prepareWorkspaceTab } from "@/utils/workspace-navigation";

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

/**
 * Headless port of paseo's openProjectDirectly. Used by tests that want to
 * exercise the open-project flow without rendering the React tree. The fork's
 * production hook (useOpenProject below) currently uses its own integrated
 * implementation — this helper is intentionally a thin wrapper so behavior
 * stays test-only until the fork chooses to migrate.
 */
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

  const { buildWorkspaceTabPersistenceKey } = await import("@/stores/workspace-layout-store");
  const { buildHostWorkspaceRoute } = await import("@/utils/host-routes");
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
  const toast = useToast();
  const client = useHostRuntimeClient(normalizedServerId);
  const mergeWorkspaces = useSessionStore((state) => state.mergeWorkspaces);
  const setHasHydratedWorkspaces = useSessionStore((state) => state.setHasHydratedWorkspaces);
  const activeOrgId = useActiveOrgId();

  return useCallback(
    async (path: string) => {
      const trimmedPath = path.trim();
      if (!trimmedPath || !client || !normalizedServerId) {
        return false;
      }

      try {
        const payload = await client.openProject(trimmedPath, {
          orgId: activeOrgId ?? undefined,
        });
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
    [activeOrgId, client, mergeWorkspaces, normalizedServerId, setHasHydratedWorkspaces, toast],
  );
}
