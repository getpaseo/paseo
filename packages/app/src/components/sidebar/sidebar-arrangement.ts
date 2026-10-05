import type { WorkspaceTitleSource } from "@/hooks/use-settings";
import { resolveSidebarWorkspacePrimaryLabel } from "./sidebar-workspace-title";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { aggregateSidebarStateBuckets, STATUS_BUCKET_ORDER } from "@/utils/sidebar-agent-state";
import type {
  SidebarProjectVisibility,
  SidebarSortMode,
  SidebarWorkspaceSortMode,
} from "@/stores/sidebar-view-store";

interface SidebarProjectArrangement {
  projects: SidebarProjectEntry[];
  mode: SidebarSortMode;
  entries: ReadonlyMap<string, SidebarWorkspaceEntry>;
  projectNames: ReadonlyMap<string, string>;
}

/** Filter before splitting pins: a project with only pinned workspaces is still occupied. */
export function filterSidebarProjects(
  projects: SidebarProjectEntry[],
  visibility: SidebarProjectVisibility,
): SidebarProjectEntry[] {
  return visibility === "all"
    ? projects
    : projects.filter((project) => project.workspaces.length > 0);
}

/**
 * Sort project headers, leaving each project's workspace order and saved custom order intact.
 * Status uses the same aggregate as the collapsed project's dot; ties keep their custom order.
 * Call only in project grouping. Empty projects sort with completed projects.
 */
export function arrangeSidebarProjects({
  projects,
  mode,
  entries,
  projectNames,
}: SidebarProjectArrangement): SidebarProjectEntry[] {
  if (mode === "custom") return projects;
  if (mode === "project") {
    return sortSidebarProjectsByName({ projects, projectNames });
  }

  const statusRanks = new Map(
    projects.map((project) => {
      const buckets = project.workspaces.flatMap((workspace) => {
        const entry = entries.get(workspace.workspaceKey);
        return entry ? [entry.statusBucket] : [];
      });
      const status = aggregateSidebarStateBuckets(buckets);
      return [project.viewKey, STATUS_BUCKET_ORDER.indexOf(status)];
    }),
  );
  return [...projects].sort((a, b) => statusRanks.get(a.viewKey)! - statusRanks.get(b.viewKey)!);
}

interface SidebarProjectNameSorting {
  projects: SidebarProjectEntry[];
  projectNames?: ReadonlyMap<string, string>;
}

/** Alphabetize project headers without changing their saved order or workspace rows. */
export function sortSidebarProjectsByName({
  projects,
  projectNames,
}: SidebarProjectNameSorting): SidebarProjectEntry[] {
  return [...projects].sort((a, b) => {
    const aName = projectNames?.get(a.viewKey) ?? a.projectName;
    const bName = projectNames?.get(b.viewKey) ?? b.projectName;
    return aName.localeCompare(bName);
  });
}

interface SidebarWorkspaceArrangement<T extends SidebarWorkspacePlacement> {
  workspaces: T[];
  mode: SidebarWorkspaceSortMode;
  workspaceTitleSource: WorkspaceTitleSource;
  entries: ReadonlyMap<string, SidebarWorkspaceEntry>;
}

/** Sort visible workspace rows without changing saved custom order; ties retain their input order. */
export function arrangeSidebarWorkspaces<T extends SidebarWorkspacePlacement>({
  workspaces,
  mode,
  entries,
  workspaceTitleSource,
}: SidebarWorkspaceArrangement<T>): T[] {
  if (mode === "custom") return workspaces;
  return [...workspaces].sort((a, b) => {
    if (mode === "name") {
      // Sort the same label the row renders, including the branch preference and its fallback.
      const aName = resolveSidebarWorkspacePrimaryLabel({
        workspace: entries.get(a.workspaceKey) ?? { name: a.name, currentBranch: null },
        workspaceTitleSource,
      });
      const bName = resolveSidebarWorkspacePrimaryLabel({
        workspace: entries.get(b.workspaceKey) ?? { name: b.name, currentBranch: null },
        workspaceTitleSource,
      });
      return aName.localeCompare(bName);
    }
    const aStatus = entries.get(a.workspaceKey)?.statusBucket ?? "done";
    const bStatus = entries.get(b.workspaceKey)?.statusBucket ?? "done";
    return STATUS_BUCKET_ORDER.indexOf(aStatus) - STATUS_BUCKET_ORDER.indexOf(bStatus);
  });
}
