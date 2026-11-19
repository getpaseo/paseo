import { useMemo, useRef } from "react";
import { shallow } from "zustand/shallow";
import { useStoreWithEqualityFn } from "zustand/traditional";
import type {
  SidebarProjectEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { applyStoredOrdering } from "@/hooks/sidebar-workspaces-view-model";
import { useHostFeatureMap } from "@/runtime/host-features";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { hasVisibleOrderChanged } from "@/utils/sidebar-reorder";

type WorkspacePin = Pick<WorkspaceDescriptor, "pinnedAt" | "pinnedOrder">;

export interface PinnedSidebarKeys {
  pinnedWorkspaceKeys: string[];
  // workspaceKey -> pinnedAt ISO string, used to order by recency.
  pinnedAtByKey: Record<string, string>;
  pinnedOrderByKey: Record<string, number>;
}

export interface PinnedSidebarGroups {
  // Individually pinned chats, hoisted into the Pinned section and removed from their
  // project below.
  pinnedChats: SidebarWorkspacePlacement[];
  syncedHostIds: ReadonlySet<string>;
  // Everything else, with pinned chats removed. Feeds the draggable project list.
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
  workspaceMaps: ReadonlyMap<string, ReadonlyMap<string, WorkspacePin>>,
): PinnedSidebarKeys {
  const pinnedWorkspaceKeys: string[] = [];
  const pinnedAtByKey: Record<string, string> = {};
  const pinnedOrderByKey: Record<string, number> = {};

  for (const project of projects) {
    for (const placement of project.workspaces) {
      const workspace = workspaceMaps.get(placement.serverId)?.get(placement.workspaceId);
      if (workspace?.pinnedAt) {
        pinnedWorkspaceKeys.push(placement.workspaceKey);
        pinnedAtByKey[placement.workspaceKey] = workspace.pinnedAt;
        if (workspace.pinnedOrder !== undefined) {
          pinnedOrderByKey[placement.workspaceKey] = workspace.pinnedOrder;
        }
      }
    }
  }
  return { pinnedWorkspaceKeys, pinnedAtByKey, pinnedOrderByKey };
}

function arePinnedSidebarKeysEqual(left: PinnedSidebarKeys, right: PinnedSidebarKeys): boolean {
  if (left.pinnedWorkspaceKeys.length !== right.pinnedWorkspaceKeys.length) {
    return false;
  }
  for (let index = 0; index < left.pinnedWorkspaceKeys.length; index += 1) {
    const workspaceKey = left.pinnedWorkspaceKeys[index];
    if (
      workspaceKey !== right.pinnedWorkspaceKeys[index] ||
      (workspaceKey &&
        (left.pinnedAtByKey[workspaceKey] !== right.pinnedAtByKey[workspaceKey] ||
          left.pinnedOrderByKey[workspaceKey] !== right.pinnedOrderByKey[workspaceKey]))
    ) {
      return false;
    }
  }
  return true;
}

export function usePinnedSidebarKeys(projects: SidebarProjectEntry[]): {
  keys: PinnedSidebarKeys;
  syncedHostIds: ReadonlySet<string>;
} {
  const previousKeysRef = useRef<PinnedSidebarKeys>({
    pinnedWorkspaceKeys: [],
    pinnedAtByKey: {},
    pinnedOrderByKey: {},
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
  const supportsPinnedOrder = useHostFeatureMap(serverIds, "workspacePinOrder");
  // COMPAT(workspacePinOrder): added after v0.16.2, remove local ordering for older hosts after 2027-05-19.
  const syncedHostIds = useMemo(
    () => new Set(serverIds.filter((serverId) => supportsPinnedOrder.get(serverId))),
    [serverIds, supportsPinnedOrder],
  );
  const workspaceMaps = useStoreWithEqualityFn(
    useSessionStore,
    (state) => serverIds.map((serverId) => state.sessions[serverId]?.workspaces ?? null),
    shallow,
  );
  const keys = useMemo(() => {
    const workspaceMapByServerId = new Map<string, ReadonlyMap<string, WorkspacePin>>();
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
  return { keys, syncedHostIds };
}

// Splits the sidebar into a dedicated Pinned section (chats) and the regular list below.
export function splitPinnedSidebarGroups(input: {
  projects: SidebarProjectEntry[];
  keys: PinnedSidebarKeys;
  pinnedWorkspaceOrder: string[];
  syncedHostIds: ReadonlySet<string>;
}): PinnedSidebarGroups {
  const { projects, keys, pinnedWorkspaceOrder, syncedHostIds } = input;
  if (keys.pinnedWorkspaceKeys.length === 0) {
    return { pinnedChats: [], syncedHostIds, unpinnedProjects: projects };
  }
  const pinnedWorkspaceKeySet = new Set(keys.pinnedWorkspaceKeys);
  const pinnedChats: SidebarWorkspacePlacement[] = [];
  const unpinnedProjects: SidebarProjectEntry[] = [];

  for (const project of projects) {
    for (const workspace of project.workspaces) {
      if (pinnedWorkspaceKeySet.has(workspace.workspaceKey)) {
        pinnedChats.push(workspace);
      }
    }
    unpinnedProjects.push(projectWithoutPinnedWorkspaces(project, pinnedWorkspaceKeySet));
  }

  const byRecency = (a: SidebarWorkspacePlacement, b: SidebarWorkspacePlacement) =>
    (keys.pinnedAtByKey[b.workspaceKey] ?? "").localeCompare(
      keys.pinnedAtByKey[a.workspaceKey] ?? "",
    ) || a.workspaceKey.localeCompare(b.workspaceKey);
  pinnedChats.sort(byRecency);

  // A combined sidebar uses pin recency to place each host's slots, then
  // applies that host's order within its own slots.
  const byHost = groupPinsByOrderOwner(pinnedChats, syncedHostIds);
  const ranks = keys.pinnedOrderByKey;
  byHost.set(
    null,
    applyStoredOrdering({
      items: byHost.get(null) ?? [],
      storedOrder: pinnedWorkspaceOrder,
      getKey: (workspace) => workspace.workspaceKey,
    }),
  );
  for (const [serverId, workspaces] of byHost) {
    if (serverId === null) continue;
    workspaces.sort(
      (a, b) => (ranks[a.workspaceKey] ?? -1) - (ranks[b.workspaceKey] ?? -1) || byRecency(a, b),
    );
  }
  const offsets = new Map<string | null, number>();
  return {
    pinnedChats: pinnedChats.map((workspace) => {
      const owner = syncedHostIds.has(workspace.serverId) ? workspace.serverId : null;
      const index = offsets.get(owner) ?? 0;
      offsets.set(owner, index + 1);
      return byHost.get(owner)![index]!;
    }),
    syncedHostIds,
    unpinnedProjects,
  };
}

function groupPinsByOrderOwner(
  workspaces: readonly SidebarWorkspacePlacement[],
  syncedHostIds: ReadonlySet<string>,
): Map<string | null, SidebarWorkspacePlacement[]> {
  const groups = new Map<string | null, SidebarWorkspacePlacement[]>();
  for (const workspace of workspaces) {
    const owner = syncedHostIds.has(workspace.serverId) ? workspace.serverId : null;
    const group = groups.get(owner);
    if (group) group.push(workspace);
    else groups.set(owner, [workspace]);
  }
  return groups;
}

export function planPinnedSidebarReorder(
  current: PinnedSidebarGroups,
  reordered: SidebarWorkspacePlacement[],
): Map<string | null, SidebarWorkspacePlacement[]> {
  const byOwner = groupPinsByOrderOwner(reordered, current.syncedHostIds);
  const currentByOwner = groupPinsByOrderOwner(current.pinnedChats, current.syncedHostIds);
  for (const [owner, workspaces] of byOwner) {
    if (
      !hasVisibleOrderChanged({
        currentOrder: (currentByOwner.get(owner) ?? []).map((workspace) => workspace.workspaceKey),
        reorderedVisibleKeys: workspaces.map((workspace) => workspace.workspaceKey),
      })
    ) {
      byOwner.delete(owner);
    }
  }
  return byOwner;
}
