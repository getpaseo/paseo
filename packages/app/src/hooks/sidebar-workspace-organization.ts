import type { WorkspaceCollection } from "@/stores/session-store";
import type {
  SidebarLastActivityFilter,
  SidebarSortMode,
  SidebarStatusFilter,
  SidebarVisibilityFilter,
} from "@/stores/sidebar-view-store";
import type { SidebarProjectEntry, SidebarWorkspaceEntry } from "./sidebar-workspaces-view-model";

export interface SidebarWorkspaceCollection {
  key: string;
  serverId: string | null;
  collectionId: string | null;
  label: string;
  rows: SidebarWorkspaceEntry[];
}

export interface SidebarWorkspaceOrganization {
  projects: SidebarProjectEntry[];
  pinnedProjects: SidebarProjectEntry[];
  hiddenProjects: SidebarProjectEntry[];
  regularRows: SidebarWorkspaceEntry[];
  pinnedRows: SidebarWorkspaceEntry[];
  hiddenRows: SidebarWorkspaceEntry[];
  collectionGroups: SidebarWorkspaceCollection[];
}

export function selectUngroupedSidebarProjects(input: {
  pinnedProjects: readonly SidebarProjectEntry[];
  projects: readonly SidebarProjectEntry[];
}): { pinnedProjects: SidebarProjectEntry[]; projects: SidebarProjectEntry[] } {
  return {
    pinnedProjects: [...input.pinnedProjects],
    projects: input.projects.filter((project) => project.workspaces.length === 0),
  };
}

interface SidebarOrganizationPreferences {
  sortMode: SidebarSortMode;
  visibilityFilter: SidebarVisibilityFilter;
  lastActivityFilter: SidebarLastActivityFilter;
  statusFilters: readonly SidebarStatusFilter[];
  projectFilters: readonly string[];
}

interface SidebarWorkspaceCollectionSource {
  serverId: string;
  collections: Iterable<WorkspaceCollection>;
}

interface OrganizeSidebarWorkspacesInput {
  projects: readonly SidebarProjectEntry[];
  entriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  pinnedProjectKeys?: ReadonlySet<string>;
  hiddenProjectKeys?: ReadonlySet<string>;
  hiddenWorkspaceKeys: ReadonlySet<string>;
  collections: readonly SidebarWorkspaceCollectionSource[];
  preferences: SidebarOrganizationPreferences;
  now?: Date;
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function compareOptionalDatesDescending(left: Date | null, right: Date | null): number {
  if (left && right) return right.getTime() - left.getTime();
  if (left) return -1;
  if (right) return 1;
  return 0;
}

function compareWorkspaceNames(left: SidebarWorkspaceEntry, right: SidebarWorkspaceEntry): number {
  return compareText(left.name, right.name) || compareText(left.workspaceKey, right.workspaceKey);
}

function workspaceComparator(input: {
  sortMode: SidebarSortMode;
  manualIndexByKey: ReadonlyMap<string, number>;
}): (left: SidebarWorkspaceEntry, right: SidebarWorkspaceEntry) => number {
  const { sortMode, manualIndexByKey } = input;
  if (sortMode === "alphabetical") return compareWorkspaceNames;
  if (sortMode === "created") {
    return (left, right) =>
      compareOptionalDatesDescending(left.createdAt ?? null, right.createdAt ?? null) ||
      compareWorkspaceNames(left, right);
  }
  if (sortMode === "recency") {
    return (left, right) =>
      compareOptionalDatesDescending(left.activityAt ?? null, right.activityAt ?? null) ||
      compareWorkspaceNames(left, right);
  }
  return (left, right) => {
    const leftIndex = manualIndexByKey.get(left.workspaceKey) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = manualIndexByKey.get(right.workspaceKey) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex || compareWorkspaceNames(left, right);
  };
}

function lastActivityThreshold(filter: SidebarLastActivityFilter, now: Date): number | null {
  if (filter === "all") return null;
  if (filter === "today") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }
  const days = filter === "seven_days" ? 7 : 30;
  return now.getTime() - days * 24 * 60 * 60 * 1000;
}

function workspaceMatchesFilters(input: {
  workspace: SidebarWorkspaceEntry;
  preferences: SidebarOrganizationPreferences;
  activityThreshold: number | null;
}): boolean {
  const { workspace, preferences, activityThreshold } = input;
  if (
    preferences.statusFilters.length > 0 &&
    !preferences.statusFilters.includes(workspace.statusBucket)
  ) {
    return false;
  }
  if (
    preferences.projectFilters.length > 0 &&
    !preferences.projectFilters.includes(workspace.projectKey)
  ) {
    return false;
  }
  if (activityThreshold !== null) {
    return Boolean(workspace.activityAt && workspace.activityAt.getTime() >= activityThreshold);
  }
  return true;
}

function sortRows(
  rows: readonly SidebarWorkspaceEntry[],
  compare: (left: SidebarWorkspaceEntry, right: SidebarWorkspaceEntry) => number,
): SidebarWorkspaceEntry[] {
  return [...rows].sort(compare);
}

function buildCollectionGroups(input: {
  rows: readonly SidebarWorkspaceEntry[];
  collectionSources: readonly SidebarWorkspaceCollectionSource[];
  compareRows: (left: SidebarWorkspaceEntry, right: SidebarWorkspaceEntry) => number;
}): SidebarWorkspaceCollection[] {
  const collectionsByKey = new Map<string, WorkspaceCollection>();
  const groupsByKey = new Map<string, SidebarWorkspaceCollection>();
  for (const source of input.collectionSources) {
    for (const collection of source.collections) {
      const key = `${source.serverId}:${collection.id}`;
      collectionsByKey.set(key, collection);
      groupsByKey.set(key, {
        key,
        serverId: source.serverId,
        collectionId: collection.id,
        label: collection.name,
        rows: [],
      });
    }
  }

  for (const workspace of input.rows) {
    const collectionId = workspace.collectionId ?? null;
    const key = collectionId ? `${workspace.serverId}:${collectionId}` : "no-collection";
    const collection = collectionsByKey.get(key);
    const existing = groupsByKey.get(key);
    if (existing) {
      existing.rows.push(workspace);
      continue;
    }
    groupsByKey.set(key, {
      key,
      serverId: collectionId ? workspace.serverId : null,
      collectionId,
      label: collection?.name ?? (collectionId ? "Unknown label" : "No label"),
      rows: [workspace],
    });
  }

  const groups = Array.from(groupsByKey.values());
  for (const group of groups) group.rows.sort(input.compareRows);
  groups.sort((left, right) => {
    if (left.collectionId === null) return 1;
    if (right.collectionId === null) return -1;
    return compareText(left.label, right.label) || compareText(left.key, right.key);
  });
  return groups;
}

function filterProjectWorkspaces(input: {
  projects: readonly SidebarProjectEntry[];
  eligibleKeys: ReadonlySet<string>;
  regularKeys: ReadonlySet<string>;
  entriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  compareRows: (left: SidebarWorkspaceEntry, right: SidebarWorkspaceEntry) => number;
  projectFilters: readonly string[];
  keepOriginallyEmptyProjects: boolean;
}): SidebarProjectEntry[] {
  const visibleProjects: SidebarProjectEntry[] = [];
  for (const project of input.projects) {
    if (input.projectFilters.length > 0 && !input.projectFilters.includes(project.projectKey)) {
      continue;
    }
    if (project.workspaces.length === 0) {
      if (input.keepOriginallyEmptyProjects) visibleProjects.push(project);
      continue;
    }
    const eligibleWorkspaces = project.workspaces.filter((workspace) =>
      input.eligibleKeys.has(workspace.workspaceKey),
    );
    if (eligibleWorkspaces.length === 0) continue;
    const workspaces = eligibleWorkspaces.filter((workspace) =>
      input.regularKeys.has(workspace.workspaceKey),
    );
    workspaces.sort((left, right) => {
      const leftEntry = input.entriesByKey.get(left.workspaceKey);
      const rightEntry = input.entriesByKey.get(right.workspaceKey);
      if (!leftEntry || !rightEntry) return 0;
      return input.compareRows(leftEntry, rightEntry);
    });
    visibleProjects.push({ ...project, workspaces });
  }
  return visibleProjects;
}

function projectDate(
  project: SidebarProjectEntry,
  entriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>,
  field: "createdAt" | "activityAt",
): Date | null {
  let timestamp: number | null = null;
  for (const workspace of entriesByKey.values()) {
    if (workspace.projectKey !== project.projectKey) continue;
    const value = workspace[field] ?? null;
    if (!value) continue;
    if (field === "createdAt") {
      timestamp = timestamp === null ? value.getTime() : Math.min(timestamp, value.getTime());
    } else {
      timestamp = timestamp === null ? value.getTime() : Math.max(timestamp, value.getTime());
    }
  }
  return timestamp === null ? null : new Date(timestamp);
}

function projectComparator(input: {
  sortMode: SidebarSortMode;
  entriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
}): (left: SidebarProjectEntry, right: SidebarProjectEntry) => number {
  const compareNames = (left: SidebarProjectEntry, right: SidebarProjectEntry) =>
    compareText(left.projectName, right.projectName) ||
    compareText(left.projectKey, right.projectKey);
  if (input.sortMode === "alphabetical") return compareNames;
  if (input.sortMode === "created" || input.sortMode === "recency") {
    const field = input.sortMode === "created" ? "createdAt" : "activityAt";
    return (left, right) =>
      compareOptionalDatesDescending(
        projectDate(left, input.entriesByKey, field),
        projectDate(right, input.entriesByKey, field),
      ) || compareNames(left, right);
  }
  return () => 0;
}

export function orderSidebarProjects(input: {
  projects: readonly SidebarProjectEntry[];
  entriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  pinnedProjectKeys?: ReadonlySet<string>;
  sortMode: SidebarSortMode;
}): { pinnedProjects: SidebarProjectEntry[]; projects: SidebarProjectEntry[] } {
  const compareProjects = projectComparator(input);
  const ordered =
    input.sortMode === "custom" ? [...input.projects] : [...input.projects].sort(compareProjects);
  const pinnedProjectKeys = input.pinnedProjectKeys ?? new Set<string>();
  return {
    pinnedProjects: ordered.filter((project) => pinnedProjectKeys.has(project.projectKey)),
    projects: ordered.filter((project) => !pinnedProjectKeys.has(project.projectKey)),
  };
}

function flattenManualRows(input: {
  projects: readonly SidebarProjectEntry[];
  entriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
}): SidebarWorkspaceEntry[] {
  const rows: SidebarWorkspaceEntry[] = [];
  for (const project of input.projects) {
    for (const placement of project.workspaces) {
      const entry = input.entriesByKey.get(placement.workspaceKey);
      if (entry) rows.push(entry);
    }
  }
  return rows;
}

export function organizeSidebarWorkspaces(
  input: OrganizeSidebarWorkspacesInput,
): SidebarWorkspaceOrganization {
  const manualRows = flattenManualRows(input);
  const manualIndexByKey = new Map(
    manualRows.map((workspace, index) => [workspace.workspaceKey, index] as const),
  );
  const compareRows = workspaceComparator({
    sortMode: input.preferences.sortMode,
    manualIndexByKey,
  });
  const activityThreshold = lastActivityThreshold(
    input.preferences.lastActivityFilter,
    input.now ?? new Date(),
  );
  const filteredRows = manualRows.filter((workspace) =>
    workspaceMatchesFilters({
      workspace,
      preferences: input.preferences,
      activityThreshold,
    }),
  );
  const filteredKeys = new Set(filteredRows.map((workspace) => workspace.workspaceKey));
  const hiddenProjectKeys = input.hiddenProjectKeys ?? new Set<string>();
  const rowsInVisibleProjects = filteredRows.filter(
    (workspace) => !hiddenProjectKeys.has(workspace.projectKey),
  );
  const hiddenRows =
    input.preferences.visibilityFilter === "visible"
      ? []
      : sortRows(
          rowsInVisibleProjects.filter((workspace) =>
            input.hiddenWorkspaceKeys.has(workspace.workspaceKey),
          ),
          compareRows,
        );
  const visibleRows = rowsInVisibleProjects.filter(
    (workspace) => !input.hiddenWorkspaceKeys.has(workspace.workspaceKey),
  );
  const mainRows = input.preferences.visibilityFilter === "hidden" ? [] : visibleRows;
  const pinnedRows = sortRows(
    mainRows.filter((workspace) => Boolean(workspace.pinnedAt)),
    compareRows,
  );
  const regularRows = sortRows(
    mainRows.filter((workspace) => !workspace.pinnedAt),
    compareRows,
  );
  const regularKeys = new Set(regularRows.map((workspace) => workspace.workspaceKey));
  const pinnedProjectKeys = input.pinnedProjectKeys ?? new Set<string>();
  const secondaryWorkspaceFilterActive =
    input.preferences.statusFilters.length > 0 || activityThreshold !== null;
  const visibleProjects =
    input.preferences.visibilityFilter === "hidden"
      ? []
      : filterProjectWorkspaces({
          projects: input.projects.filter((project) => !hiddenProjectKeys.has(project.projectKey)),
          eligibleKeys: filteredKeys,
          regularKeys,
          entriesByKey: input.entriesByKey,
          compareRows,
          projectFilters: input.preferences.projectFilters,
          keepOriginallyEmptyProjects: !secondaryWorkspaceFilterActive,
        });
  const { pinnedProjects, projects } = orderSidebarProjects({
    projects: visibleProjects,
    entriesByKey: input.entriesByKey,
    pinnedProjectKeys,
    sortMode: input.preferences.sortMode,
  });
  const hiddenProjectRows = new Set(
    filteredRows
      .filter((workspace) => hiddenProjectKeys.has(workspace.projectKey))
      .map((workspace) => workspace.workspaceKey),
  );
  const hiddenProjectCandidates =
    input.preferences.visibilityFilter === "visible"
      ? []
      : filterProjectWorkspaces({
          projects: input.projects.filter((project) => hiddenProjectKeys.has(project.projectKey)),
          eligibleKeys: filteredKeys,
          regularKeys: hiddenProjectRows,
          entriesByKey: input.entriesByKey,
          compareRows,
          projectFilters: input.preferences.projectFilters,
          keepOriginallyEmptyProjects: !secondaryWorkspaceFilterActive,
        });
  const orderedHiddenProjects = orderSidebarProjects({
    projects: hiddenProjectCandidates,
    entriesByKey: input.entriesByKey,
    pinnedProjectKeys,
    sortMode: input.preferences.sortMode,
  });
  const hiddenProjects = [
    ...orderedHiddenProjects.pinnedProjects,
    ...orderedHiddenProjects.projects,
  ];
  const collectionGroups =
    input.preferences.visibilityFilter === "hidden"
      ? []
      : buildCollectionGroups({
          rows: regularRows,
          collectionSources: input.collections,
          compareRows,
        });

  return {
    projects,
    pinnedProjects,
    hiddenProjects,
    regularRows,
    pinnedRows,
    hiddenRows,
    collectionGroups,
  };
}
