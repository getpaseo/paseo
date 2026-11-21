import { useMemo, useRef } from "react";
import { shallow } from "zustand/shallow";
import { useStoreWithEqualityFn } from "zustand/traditional";
import type {
  SidebarProjectEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { applyStoredOrdering } from "@/hooks/sidebar-workspaces-view-model";
import { useSessionStore } from "@/stores/session-store";

export interface PinnedSidebarKeys {
  pinnedWorkspaceKeys: string[];
  // workspaceKey -> pinnedAt ISO string, used to order by recency.
  pinnedAtByKey: Record<string, string>;
}

export interface PinnedSidebarGroups {
  // Individually pinned chats, hoisted into the Pinned section and removed from their
  // unpinned project below. Most recently pinned first.
  pinnedChats: SidebarWorkspacePlacement[];
  // Pinned project groups retain every workspace, including individually pinned chats.
  pinnedProjects: SidebarProjectEntry[];
  // Unpinned project groups, with individually pinned chats removed.
  unpinnedProjects: SidebarProjectEntry[];
}

function projectWithoutPinnedWorkspaces(
  project: SidebarProjectEntry,
  pinnedWorkspaceKeys: ReadonlySet<string>,
): SidebarProjectEntry {
  const workspaces = project.workspaces.filter(
    (workspace) => !pinnedWorkspaceKeys.has(workspace.workspaceKey),
  );
  // Keep the project even when every chat moved to Pinned. The project row owns
  // its settings and new-workspace actions; chats are not its ownership boundary.
  return workspaces.length === project.workspaces.length ? project : { ...project, workspaces };
}

function buildPinnedSidebarKeys(
  projects: SidebarProjectEntry[],
  workspaceMaps: ReadonlyMap<string, ReadonlyMap<string, { pinnedAt?: string | null }>>,
): PinnedSidebarKeys {
  const pinnedWorkspaceKeys: string[] = [];
  const pinnedAtByKey: Record<string, string> = {};

  for (const project of projects) {
    for (const placement of project.workspaces) {
      const workspace = workspaceMaps.get(placement.serverId)?.get(placement.workspaceId);
      if (workspace?.pinnedAt) {
        pinnedWorkspaceKeys.push(placement.workspaceKey);
        pinnedAtByKey[placement.workspaceKey] = workspace.pinnedAt;
      }
    }
  }
  return { pinnedWorkspaceKeys, pinnedAtByKey };
}

function arePinnedSidebarKeysEqual(left: PinnedSidebarKeys, right: PinnedSidebarKeys): boolean {
  if (left.pinnedWorkspaceKeys.length !== right.pinnedWorkspaceKeys.length) {
    return false;
  }
  for (let index = 0; index < left.pinnedWorkspaceKeys.length; index += 1) {
    const workspaceKey = left.pinnedWorkspaceKeys[index];
    if (
      workspaceKey !== right.pinnedWorkspaceKeys[index] ||
      (workspaceKey && left.pinnedAtByKey[workspaceKey] !== right.pinnedAtByKey[workspaceKey])
    ) {
      return false;
    }
  }
  return true;
}

export function usePinnedSidebarKeys(projects: SidebarProjectEntry[]): PinnedSidebarKeys {
  const previousKeysRef = useRef<PinnedSidebarKeys>({
    pinnedWorkspaceKeys: [],
    pinnedAtByKey: {},
  });
  const serverIds = useMemo(
    () =>
      Array.from(
        new Set(
          projects.flatMap((project) => project.workspaces.map((workspace) => workspace.serverId)),
        ),
      ),
    [projects],
  );
  const workspaceMaps = useStoreWithEqualityFn(
    useSessionStore,
    (state) => serverIds.map((serverId) => state.sessions[serverId]?.workspaces ?? null),
    shallow,
  );
  return useMemo(() => {
    const workspaceMapByServerId = new Map<
      string,
      ReadonlyMap<string, { pinnedAt?: string | null }>
    >();
    for (let index = 0; index < serverIds.length; index += 1) {
      const serverId = serverIds[index];
      const workspaceMap = workspaceMaps[index];
      if (serverId && workspaceMap) {
        workspaceMapByServerId.set(serverId, workspaceMap);
      }
    }
    const nextKeys = buildPinnedSidebarKeys(projects, workspaceMapByServerId);
    if (arePinnedSidebarKeysEqual(previousKeysRef.current, nextKeys)) {
      return previousKeysRef.current;
    }
    previousKeysRef.current = nextKeys;
    return nextKeys;
  }, [projects, serverIds, workspaceMaps]);
}

// Splits the sidebar into a dedicated Pinned section (chats) and the regular list below.
// Pinned chats are ordered most-recently-pinned first.
export function splitPinnedSidebarGroups(input: {
  projects: SidebarProjectEntry[];
  keys: PinnedSidebarKeys;
  pinnedWorkspaceOrder: string[];
  pinnedProjectKeys: readonly string[];
}): PinnedSidebarGroups {
  const { projects, keys, pinnedWorkspaceOrder, pinnedProjectKeys } = input;
  const pinnedProjectKeySet = new Set(pinnedProjectKeys);
  const hasPinnedProject = projects.some((project) => pinnedProjectKeySet.has(project.viewKey));
  if (keys.pinnedWorkspaceKeys.length === 0 && !hasPinnedProject) {
    return { pinnedChats: [], pinnedProjects: [], unpinnedProjects: projects };
  }
  const pinnedWorkspaceKeySet = new Set(keys.pinnedWorkspaceKeys);
  const pinnedChats: SidebarWorkspacePlacement[] = [];
  const pinnedProjects: SidebarProjectEntry[] = [];
  const unpinnedProjects: SidebarProjectEntry[] = [];

  for (const project of projects) {
    for (const workspace of project.workspaces) {
      if (pinnedWorkspaceKeySet.has(workspace.workspaceKey)) {
        pinnedChats.push(workspace);
      }
    }
    if (pinnedProjectKeySet.has(project.viewKey)) {
      pinnedProjects.push(project);
    } else {
      unpinnedProjects.push(projectWithoutPinnedWorkspaces(project, pinnedWorkspaceKeySet));
    }
  }

  pinnedChats.sort((a, b) => {
    const recency = (keys.pinnedAtByKey[b.workspaceKey] ?? "").localeCompare(
      keys.pinnedAtByKey[a.workspaceKey] ?? "",
    );
    return recency || a.workspaceKey.localeCompare(b.workspaceKey);
  });

  return {
    pinnedChats: applyStoredOrdering({
      items: pinnedChats,
      storedOrder: pinnedWorkspaceOrder,
      getKey: (workspace) => workspace.workspaceKey,
    }),
    pinnedProjects,
    unpinnedProjects,
  };
}
