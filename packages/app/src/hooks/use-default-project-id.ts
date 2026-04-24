import { useMemo } from "react";
import { useHosts } from "@/runtime/host-runtime";
import { useSidebarWorkspacesList } from "./use-sidebar-workspaces-list";

/**
 * Resolves the project key to pre-select when the UI doesn't have an explicit
 * workspace/project context (e.g. the Library screen). Uses the first
 * connected daemon and picks the project with the most active workspaces,
 * falling back to the first project when none are active.
 *
 * Returns `null` when no daemon is connected or no projects exist.
 */
export function useDefaultProjectId(): string | null {
  const hosts = useHosts();
  const serverId = hosts[0]?.serverId ?? null;
  const { projects } = useSidebarWorkspacesList({ serverId });

  return useMemo(() => {
    if (projects.length === 0) return null;
    const withActive = projects.find((p) => p.activeCount > 0);
    return (withActive ?? projects[0])?.projectKey ?? null;
  }, [projects]);
}
