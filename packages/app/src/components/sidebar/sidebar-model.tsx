import { useTranslation } from "react-i18next";
import React, { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import {
  useSidebarWorkspacesList,
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
  type SidebarWorkspacesListResult,
} from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarWorkspaceEntries } from "@/hooks/use-sidebar-workspace-entries";
import { usePinnedSidebarKeys, type PinnedSidebarGroups } from "@/hooks/use-sidebar-pins";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import {
  hasActiveSidebarLabelFilter,
  useSidebarViewStore,
  type SidebarGroupMode,
} from "@/stores/sidebar-view-store";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import type { SidebarShortcutModel } from "@/utils/sidebar-shortcuts";
import { buildSidebarProjection } from "./sidebar-projection";
import type { SidebarProjectIconTarget } from "@/utils/sidebar-project-row-model";
import { filterWorkspacesByLabels, type SidebarWorkspaceGroup } from "./sidebar-labels";
import { filterWorkspacesByProjects, resolveActiveProjectFilters } from "./sidebar-project-filter";
import {
  hasAuthoritativeWorkspaceLabelCatalog,
  useWorkspaceLabelProjection,
} from "@/workspace-labels";
import { useNestedSubagentWorkspaces } from "@/components/sidebar/workspace-tabs/use-nested-workspaces";
import {
  childTimesByParent,
  orderWorkspaceKeys,
  type WorkspaceSortClock,
} from "@/components/sidebar/workspace-tabs/nested-sort";
import { useWorkspaceSortClocks } from "@/components/sidebar/workspace-tabs/sort-clocks";
import type { WorkspaceSort } from "@/projects/workspace-structure";

interface SidebarModel extends SidebarWorkspacesListResult {
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  /**
   * Every project the sidebar could show, before any filter narrows it.
   *
   * `projects` is the FILTERED list. A surface that offers a filter picker must read this one, or
   * narrowing the filter deletes the rows that would undo it.
   */
  allProjects: SidebarProjectEntry[];
  /** The project filter as it is actually being applied — see `resolveActiveProjectFilters`. */
  resolvedProjectFilters: readonly string[];
  hasProjectsBeforeFilter: boolean;
  groupMode: SidebarGroupMode;
  workspaceGroups: SidebarWorkspaceGroup[];
  projectIconTargets: SidebarProjectIconTarget[];
  pinnedGroups: PinnedSidebarGroups;
  collapsedProjectKeys: ReadonlySet<string>;
  toggleProjectCollapsed: (projectViewKey: string) => void;
  shortcutModel: SidebarShortcutModel;
}

const SidebarModelContext = createContext<SidebarModel | null>(null);
const NO_CHILD_TIMES: ReadonlyMap<string, number> = new Map();

function zeroSortTime(): number {
  return 0;
}

function orderNestedProjectWorkspaces(input: {
  project: SidebarProjectEntry;
  nestedKeys: ReadonlySet<string>;
  sort: WorkspaceSort | undefined;
  timeOf: (workspaceKey: string) => number;
  childTimeByParent: ReadonlyMap<string, number>;
}): SidebarProjectEntry {
  const { project, nestedKeys, sort, timeOf, childTimeByParent } = input;
  const keys = project.workspaces.map((workspace) => workspace.workspaceKey);
  const ordered = orderWorkspaceKeys(keys, nestedKeys, sort, timeOf, childTimeByParent);
  if (ordered === keys) return project;
  const byKey = new Map(project.workspaces.map((workspace) => [workspace.workspaceKey, workspace]));
  const workspaces: SidebarProjectEntry["workspaces"] = [];
  for (const key of ordered) {
    const workspace = byKey.get(key);
    if (workspace) workspaces.push(workspace);
  }
  return { ...project, workspaces };
}

function clockTime(
  clocks: ReadonlyMap<string, WorkspaceSortClock>,
  workspaceKey: string,
  sort: "created" | "lastPrompt",
): number | null {
  const clock = clocks.get(workspaceKey);
  if (!clock) return null;
  return sort === "lastPrompt" ? clock.lastPromptAt : clock.createdAt;
}

export function SidebarModelProvider({
  active,
  keyboardNavigationActive = false,
  children,
}: {
  active?: boolean;
  keyboardNavigationActive?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const modelActive = active !== false || keyboardNavigationActive;
  const list = useSidebarWorkspacesList({ enabled: modelActive });
  const showBackground = useSidebarViewStore((state) => state.showBackground);
  // Workspaces that only hold subagents are listed under their parent's tab instead.
  const nestedWorkspaces = useNestedSubagentWorkspaces();
  const workspaceClocks = useWorkspaceSortClocks();
  const groupMode = useSidebarViewStore((state) => state.groupMode);
  const workspaceSort = useSidebarViewStore((state) => state.workspaceSort);
  const activeSort =
    groupMode === "project" && (workspaceSort === "manual" || list.workspaceSortSupported)
      ? workspaceSort
      : undefined;
  const labelFilter = useSidebarViewStore((state) => state.labelFilter);
  const projectFilters = useSidebarViewStore((state) => state.projectFilters);
  const reconcileLabelFilter = useSidebarViewStore((state) => state.reconcileLabelFilter);
  const { hosts: labelHosts } = useWorkspaceLabelProjection();
  const collapsedProjectKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedProjectKeys,
  );
  const collapsedWorkspaceGroupKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedWorkspaceGroupKeys,
  );
  const pinnedCollapsed = useSidebarCollapsedSectionsStore((state) => state.collapsedPinned);
  const pinnedWorkspaceOrder = useSidebarOrderStore((state) => state.pinnedWorkspaceOrder);
  const toggleProjectCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.toggleProjectCollapsed,
  );
  const availableLabelNames = useMemo(
    () => labelHosts.flatMap((host) => host.labels.map((label) => label.name)),
    [labelHosts],
  );
  const hasAuthoritativeLabelCatalog = hasAuthoritativeWorkspaceLabelCatalog(labelHosts);
  useEffect(() => {
    if (!hasAuthoritativeLabelCatalog) return;
    reconcileLabelFilter(availableLabelNames);
  }, [availableLabelNames, hasAuthoritativeLabelCatalog, reconcileLabelFilter]);
  const hasActiveLabelFilter = hasActiveSidebarLabelFilter(labelFilter);
  const resolvedProjectFilters = useMemo(
    () =>
      resolveActiveProjectFilters(
        projectFilters,
        new Set(list.projects.map((project) => project.viewKey)),
      ),
    [projectFilters, list.projects],
  );
  const hasActiveProjectFilter = resolvedProjectFilters.length > 0;
  // The project filter is deliberately absent from this gate. It reads `projectViewKey`, which
  // lives on the project and the placement, so it can narrow the project list without hydrating
  // anything; the label filter reads `labels`, which only exists on an entry. Hydration opens a
  // live session-store subscription over every workspace on every visible host, so widening this
  // for a filter that does not need it costs a retained-but-inactive sidebar real work.
  // Hardware keyboard navigation needs the same filtered targets while the sidebar is hidden.
  const needsWorkspaceEntries = groupMode !== "project" || hasActiveLabelFilter;
  const workspaceEntriesByKey = useSidebarWorkspaceEntries(
    list.workspacePlacements,
    modelActive || needsWorkspaceEntries,
  );
  const filteredWorkspaceEntriesByKey = useMemo(() => {
    const byProject = filterWorkspacesByProjects({
      workspaces: [...workspaceEntriesByKey.values()],
      projectFilters: resolvedProjectFilters,
    });
    const filtered = filterWorkspacesByLabels({
      workspaces: byProject.filter(
        (workspace) =>
          (showBackground || !workspace.background) &&
          !nestedWorkspaces.keys.has(workspace.workspaceKey),
      ),
      ...labelFilter,
    });
    return new Map(filtered.map((workspace) => [workspace.workspaceKey, workspace]));
  }, [
    showBackground,
    labelFilter,
    nestedWorkspaces.keys,
    resolvedProjectFilters,
    workspaceEntriesByKey,
  ]);
  const visibleWorkspaceKeys = useMemo(
    () => new Set(filteredWorkspaceEntriesByKey.keys()),
    [filteredWorkspaceEntriesByKey],
  );
  // A nested workspace leaves the list, so its created time and last prompt move to the parent.
  // Manual order, and name order when no sort is active, only lose the hidden keys.
  const childSortTimeByParent = useMemo(() => {
    if (activeSort !== "created" && activeSort !== "lastPrompt") return NO_CHILD_TIMES;
    if (nestedWorkspaces.parentsByKey.size === 0) return NO_CHILD_TIMES;
    return childTimesByParent(nestedWorkspaces.parentsByKey, (workspaceKey) =>
      clockTime(workspaceClocks, workspaceKey, activeSort),
    );
  }, [activeSort, nestedWorkspaces.parentsByKey, workspaceClocks]);
  const sortTimeOf = useMemo(() => {
    if (activeSort !== "created" && activeSort !== "lastPrompt") return zeroSortTime;
    return (workspaceKey: string) => clockTime(workspaceClocks, workspaceKey, activeSort) ?? 0;
  }, [activeSort, workspaceClocks]);
  // Status groups keep each row in its own bucket. A nested workspace's status time only lifts
  // the parent inside that bucket; the row still shows its own timestamp.
  const childStatusEnteredAtByParent = useMemo(() => {
    if (groupMode !== "status" || nestedWorkspaces.parentsByKey.size === 0) return NO_CHILD_TIMES;
    return childTimesByParent(
      nestedWorkspaces.parentsByKey,
      (workspaceKey) => workspaceClocks.get(workspaceKey)?.statusEnteredAt ?? null,
    );
  }, [groupMode, nestedWorkspaces.parentsByKey, workspaceClocks]);
  // The two filters prune differently on purpose. The project filter is a membership test on the
  // project itself, so a project you filtered TO survives even with no workspaces — it still owns
  // a header row you can create your first workspace under. The label filter can only ask about
  // workspaces, so a project it empties has nothing left to show.
  const filteredProjects = useMemo(() => {
    let projects = list.projects;
    if (hasActiveProjectFilter) {
      const included = new Set(resolvedProjectFilters);
      projects = projects.filter((project) => included.has(project.viewKey));
    }
    if (nestedWorkspaces.keys.size > 0) {
      // Placements carry the key, so this narrows project mode without hydrating entries. A
      // project left with only nested workspaces keeps its header, like an empty project.
      projects = projects.map((project) =>
        orderNestedProjectWorkspaces({
          project,
          nestedKeys: nestedWorkspaces.keys,
          sort: activeSort,
          timeOf: sortTimeOf,
          childTimeByParent: childSortTimeByParent,
        }),
      );
    }
    if (hasActiveLabelFilter || !showBackground) {
      projects = projects.flatMap((project) => {
        const workspaces = project.workspaces.filter((workspace) =>
          visibleWorkspaceKeys.has(workspace.workspaceKey),
        );
        return workspaces.length > 0 || (!hasActiveLabelFilter && project.workspaces.length === 0)
          ? [workspaces.length === project.workspaces.length ? project : { ...project, workspaces }]
          : [];
      });
    }
    return projects;
  }, [
    showBackground,
    hasActiveLabelFilter,
    hasActiveProjectFilter,
    activeSort,
    childSortTimeByParent,
    nestedWorkspaces.keys,
    resolvedProjectFilters,
    list.projects,
    sortTimeOf,
    visibleWorkspaceKeys,
  ]);
  const pinnedKeys = usePinnedSidebarKeys(filteredProjects);
  const projectionInput = useMemo(
    () => ({
      projects: filteredProjects,
      pinnedKeys,
      pinnedWorkspaceOrder,
      workspaceEntriesByKey: filteredWorkspaceEntriesByKey,
      projectNamesByViewKey: list.projectNamesByViewKey,
      groupMode,
      pinnedCollapsed,
      collapsedProjectKeys,
      collapsedWorkspaceGroupKeys,
      childStatusEnteredAtByParent,
      t,
    }),
    [
      childStatusEnteredAtByParent,
      collapsedProjectKeys,
      collapsedWorkspaceGroupKeys,
      groupMode,
      list.projectNamesByViewKey,
      filteredProjects,
      pinnedCollapsed,
      pinnedKeys,
      pinnedWorkspaceOrder,
      filteredWorkspaceEntriesByKey,
      t,
    ],
  );
  const projection = useMemo(() => buildSidebarProjection(projectionInput), [projectionInput]);
  const value = useMemo(
    () => ({
      ...list,
      projects: filteredProjects,
      allProjects: list.projects,
      resolvedProjectFilters,
      hasProjectsBeforeFilter: list.projects.length > 0,
      workspaceEntriesByKey: filteredWorkspaceEntriesByKey,
      groupMode,
      workspaceGroups: projection.workspaceGroups,
      projectIconTargets: projection.projectIconTargets,
      pinnedGroups: projection.pinnedGroups,
      collapsedProjectKeys,
      toggleProjectCollapsed,
      shortcutModel: projection.shortcutModel,
    }),
    [
      resolvedProjectFilters,
      collapsedProjectKeys,
      groupMode,
      list,
      filteredProjects,
      projection,
      toggleProjectCollapsed,
      filteredWorkspaceEntriesByKey,
    ],
  );

  return <SidebarModelContext.Provider value={value}>{children}</SidebarModelContext.Provider>;
}

export function useSidebarModel(): SidebarModel {
  const model = useContext(SidebarModelContext);
  if (!model) throw new Error("SidebarModelProvider is required");
  return model;
}
