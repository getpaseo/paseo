import { buildStatusGroups } from "@/hooks/sidebar-status-view-model";
import {
  splitPinnedSidebarGroups,
  type PinnedSidebarGroups,
  type PinnedSidebarKeys,
} from "@/hooks/use-sidebar-pins";
import { shouldShowSidebarHostLabels } from "@/hooks/sidebar-workspaces-view-model";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
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
import { buildSidebarHostSections, type SidebarHostSection } from "./sidebar-host-sections";
import { statusWorkspaceGroups, type SidebarWorkspaceGroup } from "./sidebar-labels";

export interface SidebarProjection {
  pinnedGroups: PinnedSidebarGroups;
  workspaceGroups: SidebarWorkspaceGroup[];
  /**
   * The always-on host sections, empty while the visible sidebar spans a single host.
   *
   * When present the list renders these instead of the flat groups, with each host's own
   * divider and the active grouping nested inside it.
   */
  hostSections: SidebarHostSection[];
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
  projectNamesByViewKey: Map<string, string>;
  /** Host labels, keyed by `serverId`, for the always-on host dividers. */
  hostLabelsByServerId: ReadonlyMap<string, string>;
  groupMode: SidebarGroupMode;
  pinnedCollapsed: boolean;
  collapsedProjectKeys: ReadonlySet<string>;
  collapsedWorkspaceGroupKeys: ReadonlySet<string>;
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
  // Host dividers are always on, but only once the sidebar spans more than one host. A single
  // host is the whole list, so a divider would only repeat the titlebar.
  const hostSections = shouldShowSidebarHostLabels(input.projects)
    ? buildSidebarHostSections({
        projects: pinnedGroups.unpinnedProjects,
        unpinnedWorkspaces,
        projectNamesByViewKey: input.projectNamesByViewKey,
        hostLabelsByServerId: input.hostLabelsByServerId,
      })
    : [];
  // One switch decides both what the list groups by and what the keyboard shortcuts walk, so the
  // two cannot disagree and a new grouping mode is a compile error here rather than a silent
  // fall-through to the project rows.
  const workspaceGroups = buildWorkspaceGroups(input, unpinnedWorkspaces);
  const sections = buildShortcutSections({
    input,
    pinnedGroups,
    workspaceGroups,
    hostSections,
  });

  return {
    pinnedGroups,
    workspaceGroups,
    hostSections,
    projectIconTargets: resolveSidebarProjectIconTargets(input.projects),
    shortcutModel: buildSidebarShortcutSections({ sections }),
  };
}

function buildShortcutSections({
  input,
  pinnedGroups,
  workspaceGroups,
  hostSections,
}: {
  input: SidebarProjectionInput;
  pinnedGroups: PinnedSidebarGroups;
  workspaceGroups: SidebarWorkspaceGroup[];
  hostSections: SidebarHostSection[];
}): SidebarShortcutSection[] {
  const sections: SidebarShortcutSection[] = [];
  if (!input.pinnedCollapsed) {
    sections.push({ workspaces: pinnedGroups.pinnedChats });
  }
  if (hostSections.length > 0) {
    for (const host of hostSections) {
      if (input.groupMode === "project") {
        sections.push(
          ...host.projects.map((project) => ({
            workspaces: project.workspaces,
            collapsed: input.collapsedProjectKeys.has(project.viewKey),
          })),
        );
      } else {
        sections.push(
          ...host.workspaceGroups.map((group) => ({
            workspaces: group.rows,
            collapsed: input.collapsedWorkspaceGroupKeys.has(group.key),
          })),
        );
      }
    }
    return sections;
  }
  if (input.groupMode === "project") {
    sections.push(
      ...pinnedGroups.unpinnedProjects.map((project) => ({
        workspaces: project.workspaces,
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
  return sections;
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
