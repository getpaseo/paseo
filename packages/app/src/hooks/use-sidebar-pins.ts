import equal from "fast-deep-equal";
import { useMemo } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import type {
  SidebarProjectEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { useSessionStore } from "@/stores/session-store";

type SessionStoreState = ReturnType<typeof useSessionStore.getState>;

// A synthetic project key reserved for the row of individually-pinned chats. It never
// collides with a real project key and is never collapsible.
export const PINNED_CHATS_PSEUDO_PROJECT_KEY = "__paseo_pinned_chats__";

export interface PinnedSidebarKeys {
  pinnedWorkspaceKeys: string[];
  // workspaceKey -> pinnedAt ISO string, used to order by recency.
  pinnedAtByKey: Record<string, string>;
}

export interface PinnedSidebarGroups {
  // Individually pinned chats, hoisted into the Pinned section and removed from their
  // project below. Most recently pinned first.
  pinnedChats: SidebarWorkspacePlacement[];
  // Everything else, with pinned chats removed. Feeds the draggable project list.
  unpinnedProjects: SidebarProjectEntry[];
}

export function selectPinnedSidebarKeys(
  state: SessionStoreState,
  projects: SidebarProjectEntry[],
): PinnedSidebarKeys {
  const pinnedWorkspaceKeys: string[] = [];
  const pinnedAtByKey: Record<string, string> = {};

  for (const project of projects) {
    for (const placement of project.workspaces) {
      const workspace = state.sessions[placement.serverId]?.workspaces.get(placement.workspaceId);
      if (workspace?.pinnedAt) {
        pinnedWorkspaceKeys.push(placement.workspaceKey);
        pinnedAtByKey[placement.workspaceKey] = workspace.pinnedAt;
      }
    }
  }
  return { pinnedWorkspaceKeys, pinnedAtByKey };
}

export function usePinnedSidebarKeys(projects: SidebarProjectEntry[]): PinnedSidebarKeys {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectPinnedSidebarKeys(state, projects),
    equal,
  );
}

// Splits the sidebar into a dedicated Pinned section (chats) and the regular list below.
// Pinned chats are ordered most-recently-pinned first.
export function splitPinnedSidebarGroups(input: {
  projects: SidebarProjectEntry[];
  keys: PinnedSidebarKeys;
}): PinnedSidebarGroups {
  const { projects, keys } = input;
  if (keys.pinnedWorkspaceKeys.length === 0) {
    return { pinnedChats: [], unpinnedProjects: projects };
  }
  const pinnedWorkspaceKeySet = new Set(keys.pinnedWorkspaceKeys);
  const pinnedChats: SidebarWorkspacePlacement[] = [];
  const unpinnedProjects: SidebarProjectEntry[] = [];

  for (const project of projects) {
    const remainingWorkspaces: SidebarWorkspacePlacement[] = [];
    for (const workspace of project.workspaces) {
      if (pinnedWorkspaceKeySet.has(workspace.workspaceKey)) {
        pinnedChats.push(workspace);
      } else {
        remainingWorkspaces.push(workspace);
      }
    }
    // Every chat got hoisted into the Pinned section: drop the empty shell instead of
    // leaving a duplicate project header below. A genuinely empty project (no chats to
    // begin with) is kept so its "new workspace" row stays reachable.
    if (remainingWorkspaces.length === 0 && project.workspaces.length > 0) {
      continue;
    }
    unpinnedProjects.push(
      remainingWorkspaces.length === project.workspaces.length
        ? project
        : { ...project, workspaces: remainingWorkspaces },
    );
  }

  pinnedChats.sort((a, b) =>
    (keys.pinnedAtByKey[b.workspaceKey] ?? "").localeCompare(
      keys.pinnedAtByKey[a.workspaceKey] ?? "",
    ),
  );

  return { pinnedChats, unpinnedProjects };
}

// Flattens the pinned groups into a project list matching the sidebar's visual order
// (pinned chats first, then the rest) so keyboard shortcut numbers line up with what the
// user sees. When the Pinned section is collapsed its chats are hidden, so they must not
// consume shortcut numbers — only the unpinned list below is visible.
export function buildPinAwareShortcutProjects(
  groups: PinnedSidebarGroups,
  options?: { pinnedCollapsed?: boolean },
): SidebarProjectEntry[] {
  if (options?.pinnedCollapsed || groups.pinnedChats.length === 0) {
    return groups.unpinnedProjects;
  }
  const first = groups.pinnedChats[0];
  return [
    {
      projectKey: PINNED_CHATS_PSEUDO_PROJECT_KEY,
      projectName: "",
      projectKind: first?.projectKind ?? "directory",
      iconWorkingDir: "",
      hosts: [],
      workspaces: groups.pinnedChats,
    },
    ...groups.unpinnedProjects,
  ];
}

export function usePinnedSidebarGroups(projects: SidebarProjectEntry[]): PinnedSidebarGroups {
  const keys = usePinnedSidebarKeys(projects);
  return useMemo(() => splitPinnedSidebarGroups({ projects, keys }), [projects, keys]);
}
