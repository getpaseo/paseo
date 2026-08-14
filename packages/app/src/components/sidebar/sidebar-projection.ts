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
import {
  buildSidebarShortcutSections,
  type SidebarShortcutModel,
  type SidebarShortcutSection,
} from "@/utils/sidebar-shortcuts";
import {
  groupWorkspacesByLabel,
  labelWorkspaceGroups,
  statusWorkspaceGroups,
  type SidebarWorkspaceGroup,
} from "./sidebar-labels";
import type { WorkspaceLabelDefinition } from "@getpaseo/protocol/workspace-labels";

export interface SidebarProjection {
  pinnedGroups: PinnedSidebarGroups;
  workspaceGroups: SidebarWorkspaceGroup[];
  shortcutModel: SidebarShortcutModel;
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
  labelDefinitions?: readonly WorkspaceLabelDefinition[];
  unlabelledLabel: string;
}

export function buildSidebarProjection(input: SidebarProjectionInput): SidebarProjection {
  const pinnedGroups = splitPinnedSidebarGroups({
    projects: input.projects,
    keys: input.pinnedKeys,
    pinnedWorkspaceOrder: input.pinnedWorkspaceOrder,
  });
  const pinnedWorkspaceKeys = new Set(input.pinnedKeys.pinnedWorkspaceKeys);
  const statusGroups =
    input.groupMode === "status"
      ? buildStatusGroups(
          Array.from(input.workspaceEntriesByKey.values()).filter(
            (workspace) => !pinnedWorkspaceKeys.has(workspace.workspaceKey),
          ),
          input.projectNamesByViewKey,
        )
      : [];
  let workspaceGroups: SidebarWorkspaceGroup[] = [];
  if (input.groupMode === "status") workspaceGroups = statusWorkspaceGroups(statusGroups);
  if (input.groupMode === "label") {
    workspaceGroups = labelWorkspaceGroups(
      groupWorkspacesByLabel(
        Array.from(input.workspaceEntriesByKey.values()).filter(
          (workspace) => !pinnedWorkspaceKeys.has(workspace.workspaceKey),
        ),
        input.unlabelledLabel,
        input.labelDefinitions,
      ),
    );
  }

  const sections: SidebarShortcutSection[] = [];
  if (!input.pinnedCollapsed) {
    sections.push({ workspaces: pinnedGroups.pinnedChats });
  }
  if (input.groupMode === "status" || input.groupMode === "label") {
    sections.push(
      ...workspaceGroups.map((group) => ({
        workspaces: group.rows,
        collapsed: input.collapsedWorkspaceGroupKeys.has(group.key),
      })),
    );
  } else {
    sections.push(
      ...pinnedGroups.unpinnedProjects.map((project) => ({
        workspaces: project.workspaces,
        collapsed: input.collapsedProjectKeys.has(project.viewKey),
      })),
    );
  }

  return {
    pinnedGroups,
    workspaceGroups,
    shortcutModel: buildSidebarShortcutSections({ sections }),
  };
}
