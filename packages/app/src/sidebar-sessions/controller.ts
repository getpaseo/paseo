import { useCallback, useEffect, useRef, useState } from "react";
import type { SidebarSessionFilter, SidebarSessionViewMode } from "./types";

export function useSidebarSessionsController({ serverId }: { serverId: string | null }) {
  const previousServerIdRef = useRef(serverId);
  const [sidebarViewMode, setSidebarViewMode] = useState<SidebarSessionViewMode>("workspaces");
  const [sidebarSessionFilter, setSidebarSessionFilter] = useState<SidebarSessionFilter>({
    type: "all",
  });
  const [groupByProject, setGroupByProjectState] = useState(false);
  const [previewExpandedProjects, setPreviewExpandedProjects] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const setGroupByProject = useCallback((next: boolean) => {
    setGroupByProjectState(next);
    if (!next) {
      setPreviewExpandedProjects((previous) => (previous.size === 0 ? previous : new Set()));
    }
  }, []);

  const setSidebarSessionFilterWithReset = useCallback((next: SidebarSessionFilter) => {
    setSidebarSessionFilter(next);
    setPreviewExpandedProjects((previous) => (previous.size === 0 ? previous : new Set()));
  }, []);

  const toggleProjectPreviewExpanded = useCallback((projectKey: string) => {
    setPreviewExpandedProjects((previous) => {
      const next = new Set(previous);
      if (next.has(projectKey)) {
        next.delete(projectKey);
      } else {
        next.add(projectKey);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (previousServerIdRef.current === serverId) {
      return;
    }
    previousServerIdRef.current = serverId;
    setSidebarSessionFilter({ type: "all" });
    setPreviewExpandedProjects((previous) => (previous.size === 0 ? previous : new Set()));
  }, [serverId]);

  return {
    sidebarViewMode,
    setSidebarViewMode,
    sidebarSessionFilter,
    setSidebarSessionFilter: setSidebarSessionFilterWithReset,
    groupByProject,
    previewExpandedProjects,
    setGroupByProject,
    toggleProjectPreviewExpanded,
  };
}
