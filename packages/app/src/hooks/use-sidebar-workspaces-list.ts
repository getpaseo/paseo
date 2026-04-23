import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { WorkspaceDescriptorPayload } from "@server/shared/messages";
import {
  normalizeWorkspaceDescriptor,
  useSessionStore,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import {
  useWorkspaceStructure,
  type WorkspaceStructureProject,
} from "@/stores/session-store-hooks";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";

const EMPTY_ORDER: string[] = [];
const EMPTY_PROJECTS: SidebarProjectEntry[] = [];

export type SidebarStateBucket = WorkspaceDescriptor["status"];

export interface SidebarWorkspaceEntry {
  workspaceKey: string;
  serverId: string;
  workspaceId: string;
  projectRootPath?: string;
  workspaceDirectory?: string;
  projectKind: WorkspaceDescriptor["projectKind"];
  workspaceKind: WorkspaceDescriptor["workspaceKind"];
  name: string;
  statusBucket: SidebarStateBucket;
  diffStat: { additions: number; deletions: number } | null;
  scripts: WorkspaceDescriptor["scripts"];
  hasRunningScripts: boolean;
}

export interface SidebarProjectEntry {
  projectKey: string;
  projectName: string;
  projectKind: WorkspaceDescriptor["projectKind"];
  iconWorkingDir: string;
  workspaces: SidebarWorkspaceEntry[];
}

export interface SidebarWorkspacesListResult {
  projects: SidebarProjectEntry[];
  isLoading: boolean;
  isInitialLoad: boolean;
  isRevalidating: boolean;
  refreshAll: () => void;
}

function createStructuralWorkspaceEntry(input: {
  serverId: string;
  project: WorkspaceStructureProject;
  workspaceId: string;
}): SidebarWorkspaceEntry {
  return {
    workspaceKey: `${input.serverId}:${input.workspaceId}`,
    serverId: input.serverId,
    workspaceId: input.workspaceId,
    projectRootPath: input.project.iconWorkingDir,
    workspaceDirectory: undefined,
    projectKind: input.project.projectKind,
    workspaceKind: "checkout",
    name: input.workspaceId,
    statusBucket: "done",
    diffStat: null,
    scripts: [],
    hasRunningScripts: false,
  };
}

export function createSidebarWorkspaceEntry(input: {
  serverId: string;
  workspace: WorkspaceDescriptor;
}): SidebarWorkspaceEntry {
  return {
    workspaceKey: `${input.serverId}:${input.workspace.id}`,
    serverId: input.serverId,
    workspaceId: input.workspace.id,
    projectRootPath: input.workspace.projectRootPath,
    workspaceDirectory: input.workspace.workspaceDirectory,
    projectKind: input.workspace.projectKind,
    workspaceKind: input.workspace.workspaceKind,
    name: input.workspace.name,
    statusBucket: input.workspace.status,
    diffStat: input.workspace.diffStat,
    scripts: input.workspace.scripts,
    hasRunningScripts: input.workspace.scripts.some((script) => script.lifecycle === "running"),
  };
}

export function buildSidebarProjectsFromStructure(input: {
  serverId: string;
  projects: WorkspaceStructureProject[];
}): SidebarProjectEntry[] {
  if (input.projects.length === 0) {
    return EMPTY_PROJECTS;
  }

  return input.projects.map((project) => ({
    projectKey: project.projectKey,
    projectName: project.projectName,
    projectKind: project.projectKind,
    iconWorkingDir: project.iconWorkingDir,
    workspaces: project.workspaceKeys.map((workspaceId) =>
      createStructuralWorkspaceEntry({
        serverId: input.serverId,
        project,
        workspaceId,
      }),
    ),
  }));
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

function toWorkspaceDescriptor(payload: WorkspaceDescriptorPayload): WorkspaceDescriptor {
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
  const isActive = Boolean(serverId) && options?.enabled !== false;
  const persistedProjectOrder = useSidebarOrderStore((state) =>
    isActive && serverId ? (state.projectOrderByServerId[serverId] ?? EMPTY_ORDER) : EMPTY_ORDER,
  );
  const hasHydratedWorkspaces = useSessionStore((state) =>
    isActive && serverId ? (state.sessions[serverId]?.hasHydratedWorkspaces ?? false) : false,
  );
  const workspaceStructure = useWorkspaceStructure(isActive ? serverId : null);

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
    if (!serverId || workspaceStructure.projects.length === 0) {
      return EMPTY_PROJECTS;
    }
    return buildSidebarProjectsFromStructure({
      serverId,
      projects: workspaceStructure.projects,
    });
  }, [serverId, workspaceStructure]);

  useEffect(() => {
    if (!serverId) {
      return;
    }
  }, [connectionStatus, hasHydratedWorkspaces, projects, serverId]);

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
      const persistedWorkspaceOrder = useSidebarOrderStore
        .getState()
        .getWorkspaceOrder(serverId, project.projectKey);
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
  }, [persistedProjectOrder, projects, serverId]);

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
      let cursor: string | null = null;
      try {
        while (true) {
          const payload = await client.fetchWorkspaces({
            sort: [{ key: "activity_at", direction: "desc" }],
            page: cursor ? { limit: 200, cursor } : { limit: 200 },
          });
          for (const entry of payload.entries) {
            const workspace = toWorkspaceDescriptor(entry);
            next.set(workspace.id, workspace);
          }
          if (!payload.pageInfo.hasMore || !payload.pageInfo.nextCursor) {
            break;
          }
          cursor = payload.pageInfo.nextCursor;
        }
        const store = useSessionStore.getState();
        store.setWorkspaces(serverId, next);
        store.setHasHydratedWorkspaces(serverId, true);
      } catch (error) {
        console.error("[WorkspaceFetch][sidebar-refresh] failed", {
          serverId,
          cursor,
          error,
        });
        // ignore explicit refresh failures; hook keeps existing data
      }
    })();
  }, [connectionStatus, isActive, runtime, serverId]);

  const isLoading = isActive && Boolean(serverId) && !hasHydratedWorkspaces;
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
