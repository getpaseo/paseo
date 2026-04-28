import { useCallback, useEffect, useMemo, useState } from "react";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { buildSidebarShortcutModel } from "@/utils/sidebar-shortcuts";
import { isSidebarProjectFlattened } from "@/utils/sidebar-project-row-model";

export function useSidebarShortcutModel(projects: SidebarProjectEntry[]) {
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState<Set<string>>(new Set());
  const setSidebarShortcutWorkspaceTargets = useKeyboardShortcutsStore(
    (state) => state.setSidebarShortcutWorkspaceTargets,
  );
  const setVisibleWorkspaceTargets = useKeyboardShortcutsStore(
    (state) => state.setVisibleWorkspaceTargets,
  );

  const shortcutModel = useMemo(
    () =>
      buildSidebarShortcutModel({
        projects,
        collapsedProjectKeys,
      }),
    [collapsedProjectKeys, projects],
  );

  useEffect(() => {
    setCollapsedProjectKeys((prev) => {
      const collapsibleProjectKeys = new Set(
        projects
          .filter((project) => !isSidebarProjectFlattened(project))
          .map((project) => project.projectKey),
      );
      const next = new Set<string>();
      for (const key of prev) {
        if (collapsibleProjectKeys.has(key)) {
          next.add(key);
        }
      }
      return next;
    });
  }, [projects]);

  useEffect(() => {
    setSidebarShortcutWorkspaceTargets(shortcutModel.shortcutTargets);
    setVisibleWorkspaceTargets(shortcutModel.visibleTargets);
  }, [
    setSidebarShortcutWorkspaceTargets,
    setVisibleWorkspaceTargets,
    shortcutModel.shortcutTargets,
    shortcutModel.visibleTargets,
  ]);

  useEffect(() => {
    return () => {
      setSidebarShortcutWorkspaceTargets([]);
      setVisibleWorkspaceTargets([]);
    };
  }, [setSidebarShortcutWorkspaceTargets, setVisibleWorkspaceTargets]);

  const toggleProjectCollapsed = useCallback((projectKey: string) => {
    setCollapsedProjectKeys((prev) => {
      const next = new Set(prev);
      if (next.has(projectKey)) {
        next.delete(projectKey);
      } else {
        next.add(projectKey);
      }
      return next;
    });
  }, []);

  const setProjectCollapsed = useCallback((projectKey: string, collapsed: boolean) => {
    setCollapsedProjectKeys((prev) => {
      const next = new Set(prev);
      if (collapsed) {
        next.add(projectKey);
      } else {
        next.delete(projectKey);
      }
      return next;
    });
  }, []);

  return {
    collapsedProjectKeys,
    shortcutIndexByWorkspaceKey: shortcutModel.shortcutIndexByWorkspaceKey,
    setProjectCollapsed,
    toggleProjectCollapsed,
  };
}
