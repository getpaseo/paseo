import { buildStatusGroups } from "@/hooks/sidebar-status-view-model";
import {
  splitPinnedSidebarGroups,
  type PinnedSidebarGroups,
  type PinnedSidebarKeys,
} from "@/hooks/use-sidebar-pins";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import type { SidebarGroupMode } from "@/stores/sidebar-view-store";
import type { SidebarWorkspaceSection } from "@/stores/sidebar-order-store";
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

export interface SidebarProjection {
  pinnedGroups: PinnedSidebarGroups;
  workspaceGroups: SidebarWorkspaceGroup[];
  projectSections: Map<string, SidebarProjectWorkspaceSection[]>;
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

export interface SidebarProjectWorkspaceSection {
  id: string | null;
  name: string | null;
  collapseKey: string | null;
  workspaces: SidebarWorkspacePlacement[];
}

export interface SidebarProjectionInput {
  projects: SidebarProjectEntry[];
  pinnedKeys: PinnedSidebarKeys;
  pinnedWorkspaceOrder: string[];
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  projectNamesByViewKey: Map<string, string>;
  groupMode: SidebarGroupMode;
  pinnedCollapsed: boolean;
  collapsedProjectKeys: ReadonlySet<string>;
  collapsedWorkspaceGroupKeys: ReadonlySet<string>;
  collapsedWorkspaceSectionKeys: ReadonlySet<string>;
  workspaceSectionsByProject: Readonly<Record<string, SidebarWorkspaceSection[]>>;
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
  const projectSections = buildProjectSections({
    projects: pinnedGroups.unpinnedProjects,
    workspaceSectionsByProject: input.workspaceSectionsByProject,
  });
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
      ...pinnedGroups.unpinnedProjects.flatMap((project) => {
        const projectCollapsed = input.collapsedProjectKeys.has(project.viewKey);
        return (projectSections.get(project.viewKey) ?? []).map((section) => ({
          workspaces: section.workspaces,
          collapsed:
            projectCollapsed ||
            (section.collapseKey !== null &&
              input.collapsedWorkspaceSectionKeys.has(section.collapseKey)),
        }));
      }),
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
    pinnedGroups,
    workspaceGroups,
    projectSections,
    projectIconTargets: resolveSidebarProjectIconTargets(input.projects),
    shortcutModel: buildSidebarShortcutSections({ sections }),
  };
}

function buildProjectSections(input: {
  projects: PinnedSidebarGroups["unpinnedProjects"];
  workspaceSectionsByProject: Readonly<Record<string, SidebarWorkspaceSection[]>>;
}): Map<string, SidebarProjectWorkspaceSection[]> {
  const projectSections = new Map<string, SidebarProjectWorkspaceSection[]>();

  for (const project of input.projects) {
    const workspacesByKey = new Map(
      project.workspaces.map((workspace) => [workspace.workspaceKey, workspace]),
    );
    const assignedWorkspaceKeys = new Set<string>();
    const sections = (input.workspaceSectionsByProject[project.viewKey] ?? []).map((section) => {
      const workspaces = section.workspaceKeys.flatMap((workspaceKey) => {
        const workspace = workspacesByKey.get(workspaceKey);
        if (!workspace || assignedWorkspaceKeys.has(workspaceKey)) return [];
        assignedWorkspaceKeys.add(workspaceKey);
        return [workspace];
      });
      return {
        id: section.id,
        name: section.name,
        collapseKey: `${project.viewKey}::${section.id}`,
        workspaces,
      };
    });
    const unsectionedWorkspaces = project.workspaces.filter(
      (workspace) => !assignedWorkspaceKeys.has(workspace.workspaceKey),
    );
    projectSections.set(project.viewKey, [
      ...sections,
      { id: null, name: null, collapseKey: null, workspaces: unsectionedWorkspaces },
    ]);
  }

  return projectSections;
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
