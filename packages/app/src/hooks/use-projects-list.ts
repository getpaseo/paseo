import { useMemo } from "react";
import { useSessionStore } from "@/stores/session-store";

export interface ProjectEntry {
  id: string;
  displayName: string;
  rootPath: string;
  workspaceCount: number;
}

/**
 * Aggregates the workspaces streamed into the session store into a unique
 * list of projects (one entry per `projectId`). Used by the settings UI to
 * let users pick which projects a command/rule should install into without
 * having to hand-type absolute paths.
 */
export function useProjectsList(serverId: string | null): ProjectEntry[] {
  const workspaces = useSessionStore((s) =>
    serverId ? s.sessions[serverId]?.workspaces : undefined,
  );

  return useMemo(() => {
    if (!workspaces) return [];
    const byId = new Map<string, ProjectEntry>();
    for (const w of workspaces.values()) {
      if (w.status === "archived") continue;
      if (!w.projectId || !w.projectRootPath) continue;
      const existing = byId.get(w.projectId);
      if (existing) {
        existing.workspaceCount++;
        continue;
      }
      byId.set(w.projectId, {
        id: w.projectId,
        displayName: w.projectDisplayName || w.projectRootPath,
        rootPath: w.projectRootPath,
        workspaceCount: 1,
      });
    }
    return Array.from(byId.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [workspaces]);
}
