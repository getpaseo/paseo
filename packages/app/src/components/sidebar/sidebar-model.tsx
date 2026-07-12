import React, { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  useSidebarWorkspacesList,
  type SidebarWorkspaceEntry,
  type SidebarWorkspacesListResult,
} from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarWorkspaceEntries } from "@/hooks/use-sidebar-workspace-entries";
import { buildStatusGroups, type StatusGroup } from "@/hooks/sidebar-status-view-model";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useSidebarViewStore, type SidebarGroupMode } from "@/stores/sidebar-view-store";
import {
  buildSidebarShortcutModel,
  buildStatusSidebarShortcutModel,
  type SidebarShortcutModel,
} from "@/utils/sidebar-shortcuts";

interface SidebarModel extends SidebarWorkspacesListResult {
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  groupMode: SidebarGroupMode;
  statusGroups: StatusGroup[];
  collapsedProjectKeys: ReadonlySet<string>;
  toggleProjectCollapsed: (projectKey: string) => void;
  shortcutModel: SidebarShortcutModel;
}

const SidebarModelContext = createContext<SidebarModel | null>(null);

export function SidebarModelProvider({
  active,
  children,
}: {
  active?: boolean;
  children: ReactNode;
}) {
  const list = useSidebarWorkspacesList();
  const groupMode = useSidebarViewStore((state) => state.groupMode);
  const collapsedProjectKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedProjectKeys,
  );
  const collapsedStatusGroupKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedStatusGroupKeys,
  );
  const toggleProjectCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.toggleProjectCollapsed,
  );
  const isStatusMode = groupMode === "status";
  const workspaceEntriesByKey = useSidebarWorkspaceEntries(
    list.workspacePlacements,
    active !== false || isStatusMode,
  );
  const statusGroups = useMemo(
    () =>
      isStatusMode
        ? buildStatusGroups(Array.from(workspaceEntriesByKey.values()), list.projectNamesByKey)
        : [],
    [isStatusMode, list.projectNamesByKey, workspaceEntriesByKey],
  );
  const shortcutModel = useMemo(() => {
    if (isStatusMode) {
      return buildStatusSidebarShortcutModel({
        groups: statusGroups,
        collapsedStatusGroupKeys,
      });
    }
    return buildSidebarShortcutModel({ projects: list.projects, collapsedProjectKeys });
  }, [collapsedProjectKeys, collapsedStatusGroupKeys, isStatusMode, list.projects, statusGroups]);
  const value = useMemo(
    () => ({
      ...list,
      workspaceEntriesByKey,
      groupMode,
      statusGroups,
      collapsedProjectKeys,
      toggleProjectCollapsed,
      shortcutModel,
    }),
    [
      collapsedProjectKeys,
      groupMode,
      list,
      shortcutModel,
      statusGroups,
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
