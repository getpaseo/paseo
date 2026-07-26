import React, { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import equal from "fast-deep-equal";
import { useStoreWithEqualityFn } from "zustand/traditional";
import {
  useSidebarWorkspacesList,
  type SidebarWorkspaceEntry,
  type SidebarWorkspacesListResult,
} from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarWorkspaceEntries } from "@/hooks/use-sidebar-workspace-entries";
import type { StatusGroup } from "@/hooks/sidebar-status-view-model";
import { usePinnedSidebarKeys, type PinnedSidebarGroups } from "@/hooks/use-sidebar-pins";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { resolveCollapsedProjectKeys } from "@/stores/sidebar-collapsed-sections-store/state";
import { useSidebarViewStore, type SidebarGroupMode } from "@/stores/sidebar-view-store";
import { useSessionStore } from "@/stores/session-store";
import { selectActiveWorkspaceTabs } from "@/screens/workspace/active-workspace-tabs-model";
import type { SidebarShortcutModel } from "@/utils/sidebar-shortcuts";
import {
  buildSidebarProjectTree,
  expandedProjectKeysForActiveWorkspaces,
} from "@/utils/sidebar-project-tree";
import { buildSidebarProjection } from "./sidebar-projection";

interface SidebarModel extends SidebarWorkspacesListResult {
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  groupMode: SidebarGroupMode;
  statusGroups: StatusGroup[];
  pinnedGroups: PinnedSidebarGroups;
  collapsedProjectKeys: ReadonlySet<string>;
  toggleProjectCollapsed: (projectKey: string) => void;
  allProjectsExpanded: boolean;
  toggleAllProjectsExpanded: () => void;
  shortcutModel: SidebarShortcutModel;
}

const SidebarModelContext = createContext<SidebarModel | null>(null);
const EMPTY_WORKSPACE_ENTRIES = new Map<string, SidebarWorkspaceEntry>();

export function SidebarModelProvider({
  active,
  children,
}: {
  active?: boolean;
  children: ReactNode;
}) {
  const list = useSidebarWorkspacesList();
  const groupMode = useSidebarViewStore((state) => state.groupMode);
  const expandedProjectKeys = useSidebarCollapsedSectionsStore(
    (state) => state.expandedProjectKeys,
  );
  const collapsedStatusGroupKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedStatusGroupKeys,
  );
  const pinnedCollapsed = useSidebarCollapsedSectionsStore((state) => state.collapsedPinned);
  const toggleProjectCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.toggleProjectCollapsed,
  );
  const setExpandedProjectKeys = useSidebarCollapsedSectionsStore(
    (state) => state.setExpandedProjectKeys,
  );
  const activeWorkspaceTabs = useStoreWithEqualityFn(
    useSessionStore,
    selectActiveWorkspaceTabs,
    equal,
  );
  const isStatusMode = groupMode === "status";
  const workspaceEntriesByKey = useSidebarWorkspaceEntries(
    list.workspacePlacements,
    active !== false || isStatusMode,
  );
  const projectionWorkspaceEntriesByKey = isStatusMode
    ? workspaceEntriesByKey
    : EMPTY_WORKSPACE_ENTRIES;
  const pinnedKeys = usePinnedSidebarKeys(list.projects);
  const collapsedProjectKeys = useMemo(
    () =>
      resolveCollapsedProjectKeys(
        list.projects.map((project) => project.projectKey),
        expandedProjectKeys,
      ),
    [expandedProjectKeys, list.projects],
  );
  const allProjectKeys = useMemo(
    () => list.projects.map((project) => project.projectKey),
    [list.projects],
  );
  const allProjectsExpanded =
    allProjectKeys.length > 0 && allProjectKeys.every((key) => expandedProjectKeys.has(key));
  const activeWorkspaceKeys = useMemo(
    () => new Set(activeWorkspaceTabs.map((tab) => tab.key)),
    [activeWorkspaceTabs],
  );
  const activeProjectPathKeys = useMemo(
    () =>
      expandedProjectKeysForActiveWorkspaces({
        nodes: buildSidebarProjectTree({ projects: list.projects }),
        activeWorkspaceKeys,
      }),
    [activeWorkspaceKeys, list.projects],
  );
  const toggleAllProjectsExpanded = useCallback(() => {
    setExpandedProjectKeys(allProjectsExpanded ? activeProjectPathKeys : allProjectKeys);
  }, [activeProjectPathKeys, allProjectKeys, allProjectsExpanded, setExpandedProjectKeys]);
  const projection = useMemo(
    () =>
      buildSidebarProjection({
        projects: list.projects,
        pinnedKeys,
        workspaceEntriesByKey: projectionWorkspaceEntriesByKey,
        projectNamesByKey: list.projectNamesByKey,
        groupMode,
        pinnedCollapsed,
        collapsedProjectKeys,
        collapsedStatusGroupKeys,
      }),
    [
      collapsedProjectKeys,
      collapsedStatusGroupKeys,
      groupMode,
      list.projectNamesByKey,
      list.projects,
      pinnedCollapsed,
      pinnedKeys,
      projectionWorkspaceEntriesByKey,
    ],
  );
  const value = useMemo(
    () => ({
      ...list,
      workspaceEntriesByKey,
      groupMode,
      statusGroups: projection.statusGroups,
      pinnedGroups: projection.pinnedGroups,
      collapsedProjectKeys,
      toggleProjectCollapsed,
      allProjectsExpanded,
      toggleAllProjectsExpanded,
      shortcutModel: projection.shortcutModel,
    }),
    [
      collapsedProjectKeys,
      groupMode,
      list,
      projection,
      allProjectsExpanded,
      toggleAllProjectsExpanded,
      toggleProjectCollapsed,
      workspaceEntriesByKey,
    ],
  );

  return <SidebarModelContext.Provider value={value}>{children}</SidebarModelContext.Provider>;
}

export function useSidebarModel(): SidebarModel {
  const model = useContext(SidebarModelContext);
  if (!model) throw new Error("SidebarModelProvider is required");
  return model;
}
