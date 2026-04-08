import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  mergeWorkspaceSnapshotWithExisting,
  normalizeWorkspaceDescriptor,
  useSessionStore,
} from "@/stores/session-store";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { projectDisplayNameFromProjectId } from "@/utils/project-display-name";

const EMPTY_ORDER: string[] = [];
const EMPTY_PROJECTS: SidebarProjectEntry[] = [];
const EMPTY_WORKSPACE_ORDER_SCOPE: Record<string, string[]> = {};

export type SidebarStateBucket = WorkspaceDescriptor["status"];

export interface SidebarWorkspaceEntry {
  workspaceKey: string;
  serverId: string;
  workspaceId: string;
  workspaceKind: WorkspaceDescriptor["workspaceKind"];
  name: string;
  activityAt: Date | null;
  statusBucket: SidebarStateBucket;
  diffStat: { additions: number; deletions: number } | null;
}

export interface SidebarProjectEntry {
  projectKey: string;
  projectName: string;
  projectKind: WorkspaceDescriptor["projectKind"];
  iconWorkingDir: string;
  statusBucket: SidebarStateBucket;
  activeCount: number;
  totalWorkspaces: number;
  latestActivityAt: Date | null;
  workspaces: SidebarWorkspaceEntry[];
}

export interface SidebarWorkspacesListResult {
  projects: SidebarProjectEntry[];
  isLoading: boolean;
  isInitialLoad: boolean;
  isRevalidating: boolean;
  refreshAll: () => void;
}

const SIDEBAR_BUCKET_PRIORITY: Record<SidebarStateBucket, number> = {
  done: 0,
  attention: 1,
  running: 2,
  failed: 3,
  needs_input: 4,
};

function aggregateBucket(
  current: SidebarStateBucket,
  candidate: SidebarStateBucket,
): SidebarStateBucket {
  return SIDEBAR_BUCKET_PRIORITY[candidate] > SIDEBAR_BUCKET_PRIORITY[current]
    ? candidate
    : current;
}

function compareWorkspaceBaseline(
  left: SidebarWorkspaceEntry,
  right: SidebarWorkspaceEntry,
): number {
  if (left.activityAt && right.activityAt) {
    const dateDelta = right.activityAt.getTime() - left.activityAt.getTime();
    if (dateDelta !== 0) {
      return dateDelta;
    }
  } else if (left.activityAt || right.activityAt) {
    return left.activityAt ? -1 : 1;
  }

  const nameDelta = left.name.localeCompare(right.name, undefined, {
    numeric: true,
    sensitivity: "base",
  });
  if (nameDelta !== 0) {
    return nameDelta;
  }

  return left.workspaceId.localeCompare(right.workspaceId, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function compareProjectBaseline(left: SidebarProjectEntry, right: SidebarProjectEntry): number {
  if (left.latestActivityAt && right.latestActivityAt) {
    const dateDelta = right.latestActivityAt.getTime() - left.latestActivityAt.getTime();
    if (dateDelta !== 0) {
      return dateDelta;
    }
  } else if (left.latestActivityAt || right.latestActivityAt) {
    return left.latestActivityAt ? -1 : 1;
  }

  return left.projectName.localeCompare(right.projectName, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function buildSidebarProjectsFromWorkspaces(input: {
  serverId: string;
  workspaces: Iterable<WorkspaceDescriptor>;
  projectOrder: string[];
  workspaceOrderByScope: Record<string, string[]>;
}): SidebarProjectEntry[] {
  const byProject = new Map<string, SidebarProjectEntry>();

  for (const workspace of input.workspaces) {
    const project =
      byProject.get(workspace.projectId) ??
      ({
        projectKey: workspace.projectId,
        projectName:
          workspace.projectDisplayName || projectDisplayNameFromProjectId(workspace.projectId),
        projectKind: workspace.projectKind,
        iconWorkingDir: workspace.projectRootPath || workspace.id,
        statusBucket: "done",
        activeCount: 0,
        totalWorkspaces: 0,
        latestActivityAt: null,
        workspaces: [],
      } satisfies SidebarProjectEntry);

    const row: SidebarWorkspaceEntry = {
      workspaceKey: `${input.serverId}:${workspace.id}`,
      serverId: input.serverId,
      workspaceId: workspace.id,
      workspaceKind: workspace.workspaceKind,
      name: workspace.name,
      activityAt: workspace.activityAt,
      statusBucket: workspace.status,
      diffStat: workspace.diffStat,
    };

    project.workspaces.push(row);
    project.totalWorkspaces += 1;
    if (workspace.status !== "done") {
      project.activeCount += 1;
    }
    project.statusBucket = aggregateBucket(project.statusBucket, workspace.status);
    if (
      !project.latestActivityAt ||
      (workspace.activityAt && workspace.activityAt.getTime() > project.latestActivityAt.getTime())
    ) {
      project.latestActivityAt = workspace.activityAt;
    }

    byProject.set(workspace.projectId, project);
  }

  const baselineProjects = Array.from(byProject.values()).map((project) => {
    const baselineWorkspaces = [...project.workspaces];
    baselineWorkspaces.sort(compareWorkspaceBaseline);

    const workspaceOrderScopeKey = getWorkspaceOrderScopeKey(input.serverId, project.projectKey);
    const orderedWorkspaces = applyStoredOrdering({
      items: baselineWorkspaces,
      storedOrder: input.workspaceOrderByScope[workspaceOrderScopeKey] ?? EMPTY_ORDER,
      getKey: (workspace) => workspace.workspaceKey,
    });

    return {
      ...project,
      workspaces: orderedWorkspaces,
    };
  });

  baselineProjects.sort(compareProjectBaseline);

  return applyStoredOrdering({
    items: baselineProjects,
    storedOrder: input.projectOrder,
    getKey: (project) => project.projectKey,
  });
}

export function applyStoredOrdering<T>(input: {
  items: T[];
  storedOrder: string[];
  getKey: (item: T) => string;
}): T[] {
  if (input.items.length <= 1 || input.storedOrder.length === 0) {
    return input.items;
  }

  const itemByKey = new Map<string, T>();
  for (const item of input.items) {
    itemByKey.set(input.getKey(item), item);
  }

  const prunedOrder: string[] = [];
  const seen = new Set<string>();
  for (const key of input.storedOrder) {
    if (!itemByKey.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    prunedOrder.push(key);
  }

  if (prunedOrder.length === 0) {
    return input.items;
  }

  const orderedSet = new Set(prunedOrder);
  const ordered: T[] = [];
  let orderedIndex = 0;

  for (const item of input.items) {
    const key = input.getKey(item);
    if (!orderedSet.has(key)) {
      ordered.push(item);
      continue;
    }

    const targetKey = prunedOrder[orderedIndex] ?? key;
    orderedIndex += 1;
    ordered.push(itemByKey.get(targetKey) ?? item);
  }

  return ordered;
}

export function appendMissingOrderKeys(input: {
  currentOrder: string[];
  visibleKeys: string[];
}): string[] {
  if (input.visibleKeys.length === 0) {
    return input.currentOrder;
  }

  const existingKeys = new Set(input.currentOrder);
  const missingKeys = input.visibleKeys.filter((key) => !existingKeys.has(key));
  if (missingKeys.length === 0) {
    return input.currentOrder;
  }

  return [...input.currentOrder, ...missingKeys];
}

function getWorkspaceOrderScopeKey(serverId: string, projectKey: string): string {
  return `${serverId.trim()}::${projectKey.trim()}`;
}

function toWorkspaceDescriptor(payload: {
  id: string;
  projectId: string;
  projectDisplayName: string;
  projectRootPath: string;
  projectKind: WorkspaceDescriptor["projectKind"];
  workspaceKind: WorkspaceDescriptor["workspaceKind"];
  name: string;
  status: WorkspaceDescriptor["status"];
  activityAt: string | null;
}): WorkspaceDescriptor {
  return normalizeWorkspaceDescriptor(payload);
}

export function useSidebarWorkspacesList(options?: {
  serverId?: string | null;
  enabled?: boolean;
}): SidebarWorkspacesListResult {
  const runtime = getHostRuntimeStore();

  const serverId = useMemo(() => {
    const value = options?.serverId;
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }, [options?.serverId]);
  const persistedProjectOrder = useSidebarOrderStore((state) =>
    serverId ? (state.projectOrderByServerId[serverId] ?? EMPTY_ORDER) : EMPTY_ORDER,
  );
  const persistedWorkspaceOrderByScope = useSidebarOrderStore((state) =>
    serverId ? state.workspaceOrderByServerAndProject : EMPTY_WORKSPACE_ORDER_SCOPE,
  );

  const isActive = Boolean(serverId);
  const sessionWorkspaces = useSessionStore((state) =>
    isActive && serverId ? (state.sessions[serverId]?.workspaces ?? null) : null,
  );
  const hasHydratedWorkspaces = useSessionStore((state) =>
    isActive && serverId ? (state.sessions[serverId]?.hasHydratedWorkspaces ?? false) : false,
  );

  const connectionStatus = useSyncExternalStore(
    (onStoreChange) =>
      isActive && serverId ? runtime.subscribe(serverId, onStoreChange) : () => {},
    () => {
      if (!isActive || !serverId) {
        return "idle";
      }
      const snapshot = runtime.getSnapshot(serverId);
      return snapshot?.connectionStatus ?? "idle";
    },
    () => {
      if (!isActive || !serverId) {
        return "idle";
      }
      const snapshot = runtime.getSnapshot(serverId);
      return snapshot?.connectionStatus ?? "idle";
    },
  );

  const projects = useMemo(() => {
    if (!sessionWorkspaces || sessionWorkspaces.size === 0 || !serverId) {
      return EMPTY_PROJECTS;
    }
    return buildSidebarProjectsFromWorkspaces({
      serverId,
      workspaces: sessionWorkspaces.values(),
      projectOrder: persistedProjectOrder,
      workspaceOrderByScope: persistedWorkspaceOrderByScope,
    });
  }, [persistedProjectOrder, persistedWorkspaceOrderByScope, serverId, sessionWorkspaces]);

  useEffect(() => {
    if (!serverId || projects.length === 0) {
      return;
    }

    const nextProjectOrder = appendMissingOrderKeys({
      currentOrder: persistedProjectOrder,
      visibleKeys: projects.map((project) => project.projectKey),
    });
    if (nextProjectOrder !== persistedProjectOrder) {
      useSidebarOrderStore.getState().setProjectOrder(serverId, nextProjectOrder);
    }

    for (const project of projects) {
      const workspaceOrderScopeKey = getWorkspaceOrderScopeKey(serverId, project.projectKey);
      const persistedWorkspaceOrder =
        persistedWorkspaceOrderByScope[workspaceOrderScopeKey] ?? EMPTY_ORDER;
      const nextWorkspaceOrder = appendMissingOrderKeys({
        currentOrder: persistedWorkspaceOrder,
        visibleKeys: project.workspaces.map((workspace) => workspace.workspaceKey),
      });
      if (nextWorkspaceOrder !== persistedWorkspaceOrder) {
        useSidebarOrderStore
          .getState()
          .setWorkspaceOrder(serverId, project.projectKey, nextWorkspaceOrder);
      }
    }
  }, [persistedProjectOrder, persistedWorkspaceOrderByScope, projects, serverId]);

  const refreshAll = useCallback(() => {
    if (!isActive || !serverId || connectionStatus !== "online") {
      return;
    }
    const client = runtime.getClient(serverId);
    if (!client) {
      return;
    }
    void (async () => {
      const next = new Map<string, WorkspaceDescriptor>();
      const existingWorkspaces = useSessionStore.getState().sessions[serverId]?.workspaces;
      let cursor: string | null = null;
      try {
        while (true) {
          const payload = await client.fetchWorkspaces({
            sort: [{ key: "activity_at", direction: "desc" }],
            page: cursor ? { limit: 200, cursor } : { limit: 200 },
          });
          for (const entry of payload.entries) {
            const workspace = toWorkspaceDescriptor(entry);
            next.set(
              workspace.id,
              mergeWorkspaceSnapshotWithExisting({
                incoming: workspace,
                existing: existingWorkspaces?.get(workspace.id),
              }),
            );
          }
          if (!payload.pageInfo.hasMore || !payload.pageInfo.nextCursor) {
            break;
          }
          cursor = payload.pageInfo.nextCursor;
        }
        const store = useSessionStore.getState();
        store.setWorkspaces(serverId, next);
        store.setHasHydratedWorkspaces(serverId, true);
      } catch {
        // ignore explicit refresh failures; hook keeps existing data
      }
    })();
  }, [connectionStatus, isActive, runtime, serverId]);

  const isLoading =
    isActive && Boolean(serverId) && connectionStatus === "online" && !hasHydratedWorkspaces;
  const isInitialLoad = isLoading && projects.length === 0;
  const isRevalidating = false;

  return {
    projects,
    isLoading,
    isInitialLoad,
    isRevalidating,
    refreshAll,
  };
}
