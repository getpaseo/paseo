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
import type { SidebarGroupMode } from "@/stores/sidebar-view-store";
import type { ActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
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
import {
  buildSidebarLogicalWorkspaceProjection,
  type SidebarLogicalWorkspaceGrouping,
  type SidebarProjectWorkspaceRow,
} from "./sidebar-logical-workspaces";

export interface SidebarProjection {
  visibleProjects: SidebarProjectEntry[];
  pinnedGroups: PinnedSidebarGroups;
  projectWorkspaceRowsByViewKey: ReadonlyMap<string, SidebarProjectWorkspaceRow[]>;
  workspaceGroups: SidebarWorkspaceGroup[];
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
  pinnedKeys: PinnedSidebarKeys;
  pinnedWorkspaceOrder: string[];
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  inventoryProjects?: readonly SidebarProjectEntry[];
  inventoryWorkspaceEntriesByKey?: ReadonlyMap<string, SidebarWorkspaceEntry>;
  projectNamesByViewKey: Map<string, string>;
  groupMode: SidebarGroupMode;
  pinnedCollapsed: boolean;
  collapsedProjectKeys: ReadonlySet<string>;
  collapsedWorkspaceGroupKeys: ReadonlySet<string>;
  logicalWorkspaceGroupings?: readonly SidebarLogicalWorkspaceGrouping[];
  activeWorkspaceSelection?: ActiveWorkspaceSelection | null;
}

export function buildSidebarProjection(input: SidebarProjectionInput): SidebarProjection {
  const groupings = input.logicalWorkspaceGroupings ?? [];
  const activeWorkspaceSelection = input.activeWorkspaceSelection ?? null;
  const inventoryLogicalProjection = buildSidebarLogicalWorkspaceProjection({
    projects: input.inventoryProjects ?? input.projects,
    workspaceEntriesByKey: input.inventoryWorkspaceEntriesByKey ?? input.workspaceEntriesByKey,
    groupings,
    activeWorkspaceSelection,
  });
  const visibleProjects = removeRetainedHistoryProjects(
    input.projects,
    inventoryLogicalProjection.retainedHistoryWorkspaceKeys,
  );
  const visibleWorkspaceEntries = removeRetainedHistoryEntries(
    input.workspaceEntriesByKey,
    inventoryLogicalProjection.retainedHistoryWorkspaceKeys,
  );
  const workspaceKeysHiddenFromPins =
    input.groupMode === "project"
      ? inventoryLogicalProjection.managedWorkspaceKeys
      : inventoryLogicalProjection.retainedHistoryWorkspaceKeys;
  const effectivePinnedKeys =
    workspaceKeysHiddenFromPins.size === 0
      ? input.pinnedKeys
      : {
          ...input.pinnedKeys,
          pinnedWorkspaceKeys: input.pinnedKeys.pinnedWorkspaceKeys.filter(
            (key) => !workspaceKeysHiddenFromPins.has(key),
          ),
        };
  const pinnedGroups = splitPinnedSidebarGroups({
    projects: visibleProjects,
    keys: effectivePinnedKeys,
    pinnedWorkspaceOrder: input.pinnedWorkspaceOrder,
  });
  const visibleProjectProjection = buildSidebarLogicalWorkspaceProjection({
    projects: pinnedGroups.unpinnedProjects,
    workspaceEntriesByKey: visibleWorkspaceEntries,
    groupings: input.groupMode === "project" ? groupings : [],
    activeWorkspaceSelection,
  });
  const projectLogicalProjection =
    input.groupMode === "project"
      ? attachInventoryRetainedAgentSources(visibleProjectProjection, inventoryLogicalProjection)
      : visibleProjectProjection;
  const pinnedWorkspaceKeys = new Set(effectivePinnedKeys.pinnedWorkspaceKeys);
  const unpinnedWorkspaces = Array.from(visibleWorkspaceEntries.values()).filter(
    (workspace) => !pinnedWorkspaceKeys.has(workspace.workspaceKey),
  );
  // One switch decides both what the list groups by and what the keyboard shortcuts walk, so the
  // two cannot disagree and a new grouping mode is a compile error here rather than a silent
  // fall-through to the project rows.
  const workspaceGroups = buildWorkspaceGroups(input, unpinnedWorkspaces);

  const sections: SidebarShortcutSection[] = [];
  if (!input.pinnedCollapsed) {
    sections.push({ workspaces: pinnedGroups.pinnedChats });
  }
  if (input.groupMode === "project") {
    sections.push(
      ...pinnedGroups.unpinnedProjects.map((project) => ({
        workspaces: (projectLogicalProjection.rowsByProjectViewKey.get(project.viewKey) ?? []).map(
          (row) => (row.kind === "logical" ? row.targetPlacement : row.placement),
        ),
        collapsed: input.collapsedProjectKeys.has(project.viewKey),
      })),
    );
  } else {
    sections.push(
      ...workspaceGroups.map((group) => ({
        workspaces: group.rows,
        collapsed: input.collapsedWorkspaceGroupKeys.has(group.key),
      })),
    );
  }

  return {
    visibleProjects,
    pinnedGroups,
    projectWorkspaceRowsByViewKey: projectLogicalProjection.rowsByProjectViewKey,
    workspaceGroups,
    projectIconTargets: resolveSidebarProjectIconTargets(visibleProjects),
    shortcutModel: buildSidebarShortcutSections({ sections }),
  };
}

function removeRetainedHistoryProjects(
  projects: readonly SidebarProjectEntry[],
  retainedWorkspaceKeys: ReadonlySet<string>,
): SidebarProjectEntry[] {
  if (retainedWorkspaceKeys.size === 0) return [...projects];
  const visibleProjects: SidebarProjectEntry[] = [];
  for (const project of projects) {
    const workspaces = project.workspaces.filter(
      (workspace) => !retainedWorkspaceKeys.has(workspace.workspaceKey),
    );
    if (workspaces.length === project.workspaces.length) {
      visibleProjects.push(project);
      continue;
    }
    if (workspaces.length > 0 || project.workspaces.length === 0) {
      visibleProjects.push({ ...project, workspaces });
    }
  }
  return visibleProjects;
}

function removeRetainedHistoryEntries(
  entries: ReadonlyMap<string, SidebarWorkspaceEntry>,
  retainedWorkspaceKeys: ReadonlySet<string>,
): ReadonlyMap<string, SidebarWorkspaceEntry> {
  if (retainedWorkspaceKeys.size === 0) return entries;
  const visibleEntries = new Map<string, SidebarWorkspaceEntry>();
  for (const [key, entry] of entries) {
    if (!retainedWorkspaceKeys.has(key)) visibleEntries.set(key, entry);
  }
  return visibleEntries;
}

function attachInventoryRetainedAgentSources(
  visible: ReturnType<typeof buildSidebarLogicalWorkspaceProjection>,
  inventory: ReturnType<typeof buildSidebarLogicalWorkspaceProjection>,
): ReturnType<typeof buildSidebarLogicalWorkspaceProjection> {
  if (inventory.retainedHistoryWorkspaceKeys.size === 0) return visible;
  const inventoryLogicalRows = new Map(
    [...inventory.rowsByProjectViewKey.values()]
      .flat()
      .filter((row) => row.kind === "logical")
      .map((row) => [row.key, row]),
  );
  const rowsByProjectViewKey = new Map<string, SidebarProjectWorkspaceRow[]>();
  for (const [projectViewKey, rows] of visible.rowsByProjectViewKey) {
    rowsByProjectViewKey.set(
      projectViewKey,
      rows.map((row) => attachRetainedAgentSources(row, inventoryLogicalRows)),
    );
  }
  return { ...visible, rowsByProjectViewKey };
}

function attachRetainedAgentSources(
  row: SidebarProjectWorkspaceRow,
  inventoryLogicalRows: ReadonlyMap<
    string,
    Extract<SidebarProjectWorkspaceRow, { kind: "logical" }>
  >,
): SidebarProjectWorkspaceRow {
  if (row.kind !== "logical") return row;
  const inventoryRow = inventoryLogicalRows.get(row.key);
  return inventoryRow ? { ...row, retainedAgentSources: inventoryRow.retainedAgentSources } : row;
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
