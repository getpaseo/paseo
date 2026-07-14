import { buildStatusGroups, type StatusGroup } from "@/hooks/sidebar-status-view-model";
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

export interface SidebarProjection {
  pinnedGroups: PinnedSidebarGroups;
  statusGroups: StatusGroup[];
}

export function buildSidebarProjection(input: {
  projects: SidebarProjectEntry[];
  pinnedKeys: PinnedSidebarKeys;
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  projectNamesByKey: Map<string, string>;
  groupMode: SidebarGroupMode;
}): SidebarProjection {
  const pinnedGroups = splitPinnedSidebarGroups({
    projects: input.projects,
    keys: input.pinnedKeys,
  });
  const pinnedWorkspaceKeys = new Set(input.pinnedKeys.pinnedWorkspaceKeys);
  const statusGroups =
    input.groupMode === "status"
      ? buildStatusGroups(
          Array.from(input.workspaceEntriesByKey.values()).filter(
            (workspace) => !pinnedWorkspaceKeys.has(workspace.workspaceKey),
          ),
          input.projectNamesByKey,
        )
      : [];

  return {
    pinnedGroups,
    statusGroups,
  };
}
