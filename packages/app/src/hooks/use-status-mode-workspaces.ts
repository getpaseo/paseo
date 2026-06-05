import { useMemo } from "react";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useSessionStore } from "@/stores/session-store";
import {
  createSidebarWorkspaceEntry,
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
} from "./use-sidebar-workspaces-list";

const EMPTY_WORKSPACES: SidebarWorkspaceEntry[] = [];

export function useStatusModeWorkspaceEntries(input: {
  serverId: string | null;
  projects: SidebarProjectEntry[];
}): SidebarWorkspaceEntry[] {
  const workspaces = useSessionStore((state) =>
    input.serverId ? state.sessions[input.serverId]?.workspaces : undefined,
  );
  const agents = useSessionStore((state) =>
    input.serverId ? state.sessions[input.serverId]?.agents : undefined,
  );
  const pendingCreateAttempts = useCreateFlowStore((state) => state.pendingByDraftId);

  return useMemo(() => {
    if (!input.serverId || input.projects.length === 0 || !workspaces) {
      return EMPTY_WORKSPACES;
    }

    const entries: SidebarWorkspaceEntry[] = [];
    for (const placedWorkspace of input.projects.flatMap((project) => project.workspaces)) {
      const workspace = workspaces.get(placedWorkspace.workspaceId);
      entries.push(
        workspace
          ? createSidebarWorkspaceEntry({
              serverId: input.serverId,
              workspace,
              pendingCreateAttempts,
              agents,
            })
          : placedWorkspace,
      );
    }
    return entries;
  }, [agents, input.projects, input.serverId, pendingCreateAttempts, workspaces]);
}

export function useProjectNamesMap(serverId: string | null): Map<string, string> {
  const workspaces = useSessionStore((state) =>
    serverId ? state.sessions[serverId]?.workspaces : undefined,
  );

  return useMemo(() => {
    const map = new Map<string, string>();
    if (!serverId || !workspaces) return map;
    for (const workspace of workspaces.values()) {
      const key = workspace.project?.projectKey ?? workspace.projectId;
      if (!map.has(key)) {
        map.set(key, workspace.projectCustomName ?? workspace.projectDisplayName);
      }
    }
    return map;
  }, [serverId, workspaces]);
}
