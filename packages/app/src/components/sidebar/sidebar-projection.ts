import { buildStatusGroups } from "@/hooks/sidebar-status-view-model";
import {
  splitPinnedSidebarGroups,
  type PinnedSidebarGroups,
  type PinnedSidebarKeys,
} from "@/hooks/use-sidebar-pins";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import {
  compareGroupNames,
  normalizeProjectGroupName,
  projectGroupKey,
} from "@/project-groups/key";
import type { SidebarGroupMode } from "@/stores/sidebar-view-store";
import {
  resolveSidebarProjectIconTargets,
  type SidebarProjectIconTarget,
} from "@/utils/sidebar-project-row-model";
import {
  buildSidebarShortcutSections,
  type SidebarShortcutModel,
  type SidebarShortcutSection,
} from "@/utils/sidebar-shortcuts";
import { statusWorkspaceGroups, type SidebarWorkspaceGroup } from "./sidebar-labels";

/**
 * A named cluster of projects in project mode. Ordered by the stored group order, then by name;
 * members keep drag order.
 */
export interface SidebarProjectGroup {
  key: string;
  name: string;
  /** The members the sidebar draws under the header, which a filter can narrow. */
  projects: SidebarProjectEntry[];
  /**
   * Every project naming this group, filter or no filter. Renaming or dissolving a group writes
   * the name on all of them: a filter narrows what you look at, never what a whole-group action
   * does, or clearing it would show half a group left behind.
   */
  members: SidebarProjectEntry[];
}

export interface SidebarProjection {
  pinnedGroups: PinnedSidebarGroups;
  workspaceGroups: SidebarWorkspaceGroup[];
  /**
   * Project mode only. `pinnedGroups.unpinnedProjects` (already in drag order) partitioned into
   * named groups, sorted by name, and the projects that name no group. Status mode leaves both
   * empty/full-list respectively: `projectGroups` is `[]` and `ungroupedProjects` is the unpinned
   * list, so a caller that always reads these two fields never special-cases group mode.
   */
  projectGroups: SidebarProjectGroup[];
  /** Every group, hidden or not, in the order it would render with no filter applied. */
  allProjectGroupKeys: string[];
  ungroupedProjects: SidebarProjectEntry[];
  /**
   * The project icons this projection needs fetched, keyed by `projectViewKey` — one per project,
   * whatever the mode groups by. It sits here rather than beside `useProjectIcons` in the list
   * because it is the same `projects` the rows above are projected from: a mode that renders a
   * row can only ever ask for an icon this list already covers. It used to be derived in the
   * list, under a `groupMode === "status"` gate written when status was the only mode that put
   * icons on rows.
   */
  projectIconTargets: SidebarProjectIconTarget[];
  shortcutModel: SidebarShortcutModel;
}

export interface SidebarProjectionInput {
  projects: SidebarProjectEntry[];
  /** `projects` before any filter narrowed it, for actions that own a whole group. */
  allProjects: SidebarProjectEntry[];
  pinnedKeys: PinnedSidebarKeys;
  pinnedWorkspaceOrder: string[];
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  projectNamesByViewKey: Map<string, string>;
  groupMode: SidebarGroupMode;
  pinnedCollapsed: boolean;
  collapsedProjectKeys: ReadonlySet<string>;
  collapsedWorkspaceGroupKeys: ReadonlySet<string>;
  collapsedProjectGroupKeys: ReadonlySet<string>;
  /** Group keys in the order the user arranged them; groups it does not name come after, by name. */
  projectGroupOrder: readonly string[];
}

export function buildSidebarProjection(input: SidebarProjectionInput): SidebarProjection {
  const pinnedGroups = splitPinnedSidebarGroups({
    projects: input.projects,
    keys: input.pinnedKeys,
    pinnedWorkspaceOrder: input.pinnedWorkspaceOrder,
  });
  const pinnedWorkspaceKeys = new Set(input.pinnedKeys.pinnedWorkspaceKeys);
  const unpinnedWorkspaces = Array.from(input.workspaceEntriesByKey.values()).filter(
    (workspace) => !pinnedWorkspaceKeys.has(workspace.workspaceKey),
  );
  // One switch decides both what the list groups by and what the keyboard shortcuts walk, so the
  // two cannot disagree and a new grouping mode is a compile error here rather than a silent
  // fall-through to the project rows.
  const workspaceGroups = buildWorkspaceGroups(input, unpinnedWorkspaces);
  const { projectGroups, allProjectGroupKeys, ungroupedProjects } =
    input.groupMode === "project"
      ? partitionProjectGroups(
          pinnedGroups.unpinnedProjects,
          input.allProjects,
          input.projectGroupOrder,
        )
      : {
          projectGroups: [],
          allProjectGroupKeys: [],
          ungroupedProjects: pinnedGroups.unpinnedProjects,
        };

  const sections: SidebarShortcutSection[] = [];
  if (!input.pinnedCollapsed) {
    sections.push({ workspaces: pinnedGroups.pinnedChats });
  }
  if (input.groupMode === "project") {
    // Groups first, then ungrouped — the same order `ProjectModeList` renders in. A project
    // inside a collapsed group is collapsed regardless of its own state, so the keyboard
    // shortcuts and the visible rows can never disagree about which rows are numbered.
    for (const group of projectGroups) {
      const groupCollapsed = input.collapsedProjectGroupKeys.has(group.key);
      for (const project of group.projects) {
        sections.push({
          workspaces: project.workspaces,
          collapsed: groupCollapsed || input.collapsedProjectKeys.has(project.viewKey),
        });
      }
    }
    for (const project of ungroupedProjects) {
      sections.push({
        workspaces: project.workspaces,
        collapsed: input.collapsedProjectKeys.has(project.viewKey),
      });
    }
  } else {
    sections.push(
      ...workspaceGroups.map((group) => ({
        workspaces: group.rows,
        collapsed: input.collapsedWorkspaceGroupKeys.has(group.key),
      })),
    );
  }

  return {
    pinnedGroups,
    workspaceGroups,
    projectGroups,
    allProjectGroupKeys,
    ungroupedProjects,
    projectIconTargets: resolveSidebarProjectIconTargets(input.projects),
    shortcutModel: buildSidebarShortcutSections({ sections }),
  };
}

/**
 * Groups in the order the user arranged them (`order` holds group keys), then every group the
 * order does not name, by name. Keys in the order that name no group are skipped, so a group that
 * comes back under an old name gets its old place.
 */
export function orderProjectGroups<T extends { key: string; name: string }>(
  groups: readonly T[],
  order: readonly string[],
): T[] {
  const rank = new Map(order.map((key, index) => [key, index] as const));
  return [...groups].sort((left, right) => {
    const leftRank = rank.get(left.key);
    const rightRank = rank.get(right.key);
    if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
    if (leftRank !== undefined) return -1;
    if (rightRank !== undefined) return 1;
    return compareGroupNames(left.name, right.name);
  });
}

/**
 * The stored group order after the user rearranged the groups they can see.
 *
 * A filter can hide a whole group, so the groups on screen are a subset and the move only says
 * how they sit among each other. `allKeys` is every group in the order it renders unfiltered,
 * which gives a hidden group a slot even when it has no stored entry yet; only the slots the
 * visible groups hold are refilled, so nothing hidden moves.
 */
export function mergeProjectGroupOrder(input: {
  storedOrder: readonly string[];
  allKeys: readonly string[];
  visibleKeys: readonly string[];
  nextKeys: readonly string[];
}): string[] {
  const visible = new Set(input.visibleKeys);
  const stored = new Set(input.storedOrder);
  const materialized = [...input.storedOrder, ...input.allKeys.filter((key) => !stored.has(key))];
  const slots = input.nextKeys.filter((key) => visible.has(key));
  let cursor = 0;
  return materialized.map((key) => (visible.has(key) ? (slots[cursor++] ?? key) : key));
}

/**
 * Project mode only. Partitions projects (already in drag order) into named groups and an
 * ungrouped tail. Groups merge by `projectGroupKey` (trimmed, case-insensitive) so "Client X" and
 * "client x" become one group; the display name is whichever spelling was seen first. Groups
 * follow `orderProjectGroups`; members inside a group keep the incoming drag order.
 */
function partitionProjectGroups(
  projects: SidebarProjectEntry[],
  allProjects: readonly SidebarProjectEntry[],
  projectGroupOrder: readonly string[],
): {
  projectGroups: SidebarProjectGroup[];
  allProjectGroupKeys: string[];
  ungroupedProjects: SidebarProjectEntry[];
} {
  const membersByKey = new Map<string, SidebarProjectEntry[]>();
  const namesByKey = new Map<string, string>();
  for (const project of allProjects) {
    const groupName = normalizeProjectGroupName(project.group);
    if (!groupName) continue;
    const key = projectGroupKey(groupName);
    const members = membersByKey.get(key);
    if (members) members.push(project);
    else membersByKey.set(key, [project]);
    if (!namesByKey.has(key)) namesByKey.set(key, groupName);
  }
  const groupsByKey = new Map<string, SidebarProjectGroup>();
  const ungroupedProjects: SidebarProjectEntry[] = [];
  for (const project of projects) {
    const groupName = normalizeProjectGroupName(project.group);
    if (!groupName) {
      ungroupedProjects.push(project);
      continue;
    }
    const key = projectGroupKey(groupName);
    const existing = groupsByKey.get(key);
    if (existing) {
      existing.projects.push(project);
    } else {
      groupsByKey.set(key, {
        key,
        name: groupName,
        projects: [project],
        members: membersByKey.get(key) ?? [project],
      });
    }
  }
  const projectGroups = orderProjectGroups(Array.from(groupsByKey.values()), projectGroupOrder);
  const allProjectGroupKeys = orderProjectGroups(
    [...namesByKey].map(([key, name]) => ({ key, name })),
    projectGroupOrder,
  ).map((group) => group.key);
  return { projectGroups, allProjectGroupKeys, ungroupedProjects };
}

/** Project mode keeps its project headers and groups nothing; status mode groups the rows. */
function buildWorkspaceGroups(
  input: SidebarProjectionInput,
  unpinnedWorkspaces: SidebarWorkspaceEntry[],
): SidebarWorkspaceGroup[] {
  switch (input.groupMode) {
    case "project":
      return [];
    case "status":
      return statusWorkspaceGroups(
        buildStatusGroups(unpinnedWorkspaces, input.projectNamesByViewKey),
      );
  }
}
