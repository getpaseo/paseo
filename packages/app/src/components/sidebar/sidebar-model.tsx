import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/shallow";
import {
  useSidebarWorkspacesList,
  type SidebarWorkspaceEntry,
  type SidebarWorkspacesListResult,
} from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarWorkspaceEntries } from "@/hooks/use-sidebar-workspace-entries";
import type { StatusGroup } from "@/hooks/sidebar-status-view-model";
import { usePinnedSidebarKeys, type PinnedSidebarGroups } from "@/hooks/use-sidebar-pins";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useSidebarViewStore, type SidebarGroupMode } from "@/stores/sidebar-view-store";
import {
  buildSidebarShortcutSections,
  type SidebarShortcutModel,
  type SidebarShortcutSection,
} from "@/utils/sidebar-shortcuts";
import { buildSidebarProjection } from "./sidebar-projection";
import {
  organizeSidebarWorkspaces,
  type SidebarWorkspaceCollection,
} from "@/hooks/sidebar-workspace-organization";
import { useSessionStore, type WorkspaceCollection } from "@/stores/session-store";
import { useSidebarWorkspaceVisibilityStore } from "@/stores/sidebar-workspace-visibility-store";
import { useSidebarProjectPreferencesStore } from "@/stores/sidebar-project-preferences-store";
import { useHostRegistryLoaded, useHosts } from "@/runtime/host-runtime";
import { subscribeToPersistHydration } from "@/stores/persist-hydration";
import { useHostProjects } from "@/projects/host-projects";
import { resolveProjectPreferenceReconciliationKeys } from "@/components/sidebar/sidebar-project-preference-reconciliation";

const EMPTY_COLLECTIONS = new Map<string, WorkspaceCollection>();

interface SidebarModel extends SidebarWorkspacesListResult {
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  groupMode: SidebarGroupMode;
  statusGroups: StatusGroup[];
  pinnedGroups: PinnedSidebarGroups;
  pinnedProjects: SidebarWorkspacesListResult["projects"];
  hiddenProjects: SidebarWorkspacesListResult["projects"];
  hiddenRows: SidebarWorkspaceEntry[];
  ungroupedRows: SidebarWorkspaceEntry[];
  collectionGroups: SidebarWorkspaceCollection[];
  hiddenSectionCollapsed: boolean;
  collapsedCollectionKeys: ReadonlySet<string>;
  toggleHiddenSectionCollapsed: () => void;
  toggleCollectionCollapsed: (collectionKey: string) => void;
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
  const sortMode = useSidebarViewStore((state) => state.sortMode);
  const visibilityFilter = useSidebarViewStore((state) => state.visibilityFilter);
  const lastActivityFilter = useSidebarViewStore((state) => state.lastActivityFilter);
  const statusFilters = useSidebarViewStore((state) => state.statusFilters);
  const projectFilters = useSidebarViewStore((state) => state.projectFilters);
  const hostFilters = useSidebarViewStore((state) => state.hostFilters);
  const pinnedProjectKeys = useSidebarProjectPreferencesStore((state) => state.pinnedProjectKeys);
  const projectCollections = useSidebarProjectPreferencesStore((state) => state.collections);
  const projectCollectionIdByProjectKey = useSidebarProjectPreferencesStore(
    (state) => state.collectionIdByProjectKey,
  );
  const hiddenWorkspaceKeys = useSidebarWorkspaceVisibilityStore(
    (state) => state.hiddenWorkspaceKeys,
  );
  const hiddenProjectKeys = useSidebarWorkspaceVisibilityStore((state) => state.hiddenProjectKeys);
  const hiddenSectionCollapsed = useSidebarWorkspaceVisibilityStore(
    (state) => state.hiddenSectionCollapsed,
  );
  const collapsedCollectionKeysList = useSidebarWorkspaceVisibilityStore(
    (state) => state.collapsedCollectionKeys,
  );
  const toggleHiddenSectionCollapsed = useSidebarWorkspaceVisibilityStore(
    (state) => state.toggleHiddenSectionCollapsed,
  );
  const toggleCollectionCollapsed = useSidebarWorkspaceVisibilityStore(
    (state) => state.toggleCollectionCollapsed,
  );
  const collapsedProjectKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedProjectKeys,
  );
  const collapsedStatusGroupKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedStatusGroupKeys,
  );
  const pinnedCollapsed = useSidebarCollapsedSectionsStore((state) => state.collapsedPinned);
  const toggleProjectCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.toggleProjectCollapsed,
  );
  const baseWorkspaceEntriesByKey = useSidebarWorkspaceEntries(
    list.workspacePlacements,
    active !== false,
  );
  const hosts = useHosts();
  const hostRegistryLoaded = useHostRegistryLoaded();
  const allServerIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const allHostProjects = useHostProjects(allServerIds);
  const hydratedServerIds = useSessionStore(
    useShallow((state) =>
      allServerIds.filter((serverId) => state.sessions[serverId]?.hasHydratedWorkspaces ?? false),
    ),
  );
  const serverIds = useMemo(() => {
    const selected = hostFilters.length === 0 ? null : new Set(hostFilters);
    return hosts
      .map((host) => host.serverId)
      .filter((serverId) => !selected || selected.has(serverId));
  }, [hostFilters, hosts]);
  const collectionMaps = useSessionStore(
    useShallow((state) =>
      serverIds.map(
        (serverId) => state.sessions[serverId]?.workspaceCollections ?? EMPTY_COLLECTIONS,
      ),
    ),
  );
  const collectionSources = useMemo(
    () =>
      serverIds.map((serverId, index) => ({
        serverId,
        collections: Array.from((collectionMaps[index] ?? EMPTY_COLLECTIONS).values()),
      })),
    [collectionMaps, serverIds],
  );
  const workspaceEntriesByKey = useMemo(() => {
    const collectionsByServerId = new Map(
      serverIds.map((serverId, index) => [serverId, collectionMaps[index] ?? EMPTY_COLLECTIONS]),
    );
    const entries = new Map<string, SidebarWorkspaceEntry>();
    for (const [workspaceKey, workspace] of baseWorkspaceEntriesByKey) {
      const collectionLabel = workspace.collectionId
        ? (collectionsByServerId.get(workspace.serverId)?.get(workspace.collectionId)?.name ?? null)
        : null;
      entries.set(
        workspaceKey,
        workspace.collectionLabel === collectionLabel
          ? workspace
          : { ...workspace, collectionLabel },
      );
    }
    return entries;
  }, [baseWorkspaceEntriesByKey, collectionMaps, serverIds]);
  const [hasHydratedViewPreferences, setHasHydratedViewPreferences] = useState(() =>
    useSidebarViewStore.persist.hasHydrated(),
  );
  const [hasHydratedVisibilityPreferences, setHasHydratedVisibilityPreferences] = useState(() =>
    useSidebarWorkspaceVisibilityStore.persist.hasHydrated(),
  );
  useEffect(
    () =>
      subscribeToPersistHydration(useSidebarViewStore.persist, () => {
        setHasHydratedViewPreferences(true);
      }),
    [],
  );
  useEffect(
    () =>
      subscribeToPersistHydration(useSidebarWorkspaceVisibilityStore.persist, () => {
        setHasHydratedVisibilityPreferences(true);
      }),
    [],
  );
  useEffect(() => {
    if (!hasHydratedViewPreferences || !hasHydratedVisibilityPreferences || !hostRegistryLoaded) {
      return;
    }
    const projectKeys = resolveProjectPreferenceReconciliationKeys({
      hostRegistryLoaded,
      allServerIds,
      hydratedServerIds,
      allHostProjects,
    });
    if (!projectKeys) return;
    useSidebarViewStore.getState().reconcileProjectFilters(projectKeys);
    useSidebarWorkspaceVisibilityStore.getState().reconcileProjectKeys(projectKeys);
  }, [
    allHostProjects,
    allServerIds,
    hasHydratedViewPreferences,
    hasHydratedVisibilityPreferences,
    hydratedServerIds,
    hostRegistryLoaded,
  ]);
  const organization = useMemo(
    () =>
      organizeSidebarWorkspaces({
        projects: list.projects,
        entriesByKey: workspaceEntriesByKey,
        pinnedProjectKeys: new Set(pinnedProjectKeys),
        hiddenProjectKeys: new Set(hiddenProjectKeys),
        hiddenWorkspaceKeys: new Set(hiddenWorkspaceKeys),
        collections: collectionSources,
        preferences: {
          sortMode,
          visibilityFilter,
          lastActivityFilter,
          statusFilters,
          projectFilters,
        },
      }),
    [
      collectionSources,
      hiddenWorkspaceKeys,
      hiddenProjectKeys,
      lastActivityFilter,
      list.projects,
      pinnedProjectKeys,
      projectFilters,
      sortMode,
      statusFilters,
      visibilityFilter,
      workspaceEntriesByKey,
    ],
  );
  const pinnedKeys = usePinnedSidebarKeys(list.projects);
  const visibleProjectionProjects = useMemo(() => {
    const visibleRows = [...organization.pinnedRows, ...organization.regularRows];
    const visibleWorkspaceKeys = new Set(visibleRows.map((workspace) => workspace.workspaceKey));
    const sourceProjectsByKey = new Map(
      list.projects.map((project) => [project.projectKey, project] as const),
    );
    const visibleProjects: SidebarWorkspacesListResult["projects"] = [];
    for (const project of [...organization.pinnedProjects, ...organization.projects]) {
      const sourceProject = sourceProjectsByKey.get(project.projectKey);
      visibleProjects.push({
        ...project,
        workspaces:
          sourceProject?.workspaces.filter((workspace) =>
            visibleWorkspaceKeys.has(workspace.workspaceKey),
          ) ?? [],
      });
    }
    return visibleProjects;
  }, [list.projects, organization]);
  const projectionWorkspaceEntriesByKey = useMemo(
    () =>
      new Map(
        [...organization.pinnedRows, ...organization.regularRows].map(
          (workspace) => [workspace.workspaceKey, workspace] as const,
        ),
      ),
    [organization.pinnedRows, organization.regularRows],
  );
  const projection = useMemo(
    () =>
      buildSidebarProjection({
        projects: visibleProjectionProjects,
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
      pinnedCollapsed,
      pinnedKeys,
      projectionWorkspaceEntriesByKey,
      visibleProjectionProjects,
    ],
  );
  const statusGroups = useMemo(
    () => orderStatusGroupRows(projection.statusGroups, organization.regularRows),
    [organization.regularRows, projection.statusGroups],
  );
  const collapsedCollectionKeys = useMemo(
    () => new Set(collapsedCollectionKeysList),
    [collapsedCollectionKeysList],
  );
  const projectsInGroupOrder = useMemo(() => {
    const projectsByCollectionId = new Map(
      projectCollections.map((collection) => [collection.id, [] as typeof organization.projects]),
    );
    const unassignedProjects: typeof organization.projects = [];
    for (const project of organization.projects) {
      const collectionId = projectCollectionIdByProjectKey[project.projectKey];
      const group = collectionId ? projectsByCollectionId.get(collectionId) : null;
      if (group) group.push(project);
      else unassignedProjects.push(project);
    }
    const groupedProjects = [...projectCollections]
      .sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }),
      )
      .flatMap((collection) => projectsByCollectionId.get(collection.id) ?? []);
    return [...groupedProjects, ...unassignedProjects];
  }, [organization.projects, projectCollectionIdByProjectKey, projectCollections]);
  const shortcutModel = useMemo(() => {
    const sections: SidebarShortcutSection[] = [
      {
        workspaces: projection.pinnedGroups.pinnedChats,
        collapsed: pinnedCollapsed,
      },
    ];
    if (groupMode === "status") {
      sections.push(
        ...statusGroups.map((group) => ({
          workspaces: group.rows,
          collapsed: collapsedStatusGroupKeys.has(group.bucket),
        })),
      );
    } else if (groupMode === "collection") {
      sections.push(
        ...organization.collectionGroups.map((group) => ({
          workspaces: group.rows,
          collapsed: collapsedCollectionKeys.has(group.key),
        })),
      );
    } else if (groupMode === "none") {
      sections.push({ workspaces: organization.regularRows });
    } else {
      const projectRows =
        groupMode === "project_collection"
          ? [...organization.pinnedProjects, ...projectsInGroupOrder]
          : [...organization.pinnedProjects, ...organization.projects];
      sections.push(
        ...projectRows.map((project) => ({
          workspaces: project.workspaces,
          collapsed: collapsedProjectKeys.has(project.projectKey),
        })),
      );
    }
    if (visibilityFilter === "hidden") {
      sections.push({ workspaces: organization.hiddenRows });
    }
    return buildSidebarShortcutSections({ sections });
  }, [
    collapsedCollectionKeys,
    collapsedProjectKeys,
    collapsedStatusGroupKeys,
    groupMode,
    organization,
    pinnedCollapsed,
    projectsInGroupOrder,
    projection.pinnedGroups.pinnedChats,
    statusGroups,
    visibilityFilter,
  ]);
  const value = useMemo(
    () => ({
      ...list,
      projects: organization.projects,
      workspaceEntriesByKey,
      groupMode,
      statusGroups,
      pinnedGroups: projection.pinnedGroups,
      pinnedProjects: organization.pinnedProjects,
      hiddenProjects: organization.hiddenProjects,
      hiddenRows: organization.hiddenRows,
      ungroupedRows: organization.regularRows,
      collectionGroups: organization.collectionGroups,
      hiddenSectionCollapsed,
      collapsedCollectionKeys,
      toggleHiddenSectionCollapsed,
      toggleCollectionCollapsed,
      collapsedProjectKeys,
      toggleProjectCollapsed,
      shortcutModel,
    }),
    [
      collapsedProjectKeys,
      groupMode,
      hiddenSectionCollapsed,
      list,
      projection,
      organization,
      collapsedCollectionKeys,
      shortcutModel,
      statusGroups,
      toggleProjectCollapsed,
      toggleCollectionCollapsed,
      toggleHiddenSectionCollapsed,
      workspaceEntriesByKey,
    ],
  );

  return <SidebarModelContext.Provider value={value}>{children}</SidebarModelContext.Provider>;
}

function orderStatusGroupRows(
  groups: StatusGroup[],
  orderedRows: readonly SidebarWorkspaceEntry[],
): StatusGroup[] {
  const orderByKey = new Map(
    orderedRows.map((workspace, index) => [workspace.workspaceKey, index]),
  );
  return groups.map((group) => ({
    ...group,
    rows: [...group.rows].sort(
      (left, right) =>
        (orderByKey.get(left.workspaceKey) ?? Number.MAX_SAFE_INTEGER) -
        (orderByKey.get(right.workspaceKey) ?? Number.MAX_SAFE_INTEGER),
    ),
  }));
}

export function useSidebarModel(): SidebarModel {
  const model = useContext(SidebarModelContext);
  if (!model) throw new Error("SidebarModelProvider is required");
  return model;
}
