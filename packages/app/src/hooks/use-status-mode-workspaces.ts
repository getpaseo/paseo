import { useMemo } from "react";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import {
  createSidebarWorkspaceEntry,
  type SidebarWorkspaceEntry,
} from "./use-sidebar-workspaces-list";

export function useHydratedWorkspaceEntries(serverId: string | null): SidebarWorkspaceEntry[] {
  const workspaces = useSessionStore((state) =>
    serverId ? state.sessions[serverId]?.workspaces : undefined,
  );

  return useMemo(() => {
    if (!serverId || !workspaces || workspaces.size === 0) return [];
    return Array.from(workspaces.values()).map((workspace: WorkspaceDescriptor) =>
      createSidebarWorkspaceEntry({ serverId, workspace }),
    );
  }, [serverId, workspaces]);
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
