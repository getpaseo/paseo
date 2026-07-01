import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface SidebarOrderStoreState {
  projectOrder: string[];
  workspaceOrderByProject: Record<string, string[]>;
  getProjectOrder: () => string[];
  setProjectOrder: (keys: string[]) => void;
  getWorkspaceOrder: (projectKey: string) => string[];
  setWorkspaceOrder: (projectKey: string, keys: string[]) => void;
}

interface SidebarOrderPersistedState {
  projectOrder?: string[];
  workspaceOrderByProject?: Record<string, string[]>;
  projectOrderByServerId?: Record<string, string[]>;
  workspaceOrderByServerAndProject?: Record<string, string[]>;
}

interface SidebarWorkspaceOrderScope {
  serverId: string;
  projectKey: string;
}

function normalizeKeys(keys: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const rawKey of keys) {
    const key = rawKey.trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(key);
  }

  return normalized;
}

function normalizeWorkspaceOrderByProject(
  workspaceOrderByProject: Record<string, string[]> | undefined,
): Record<string, string[]> {
  const normalized: Record<string, string[]> = {};
  for (const [projectKey, order] of Object.entries(workspaceOrderByProject ?? {})) {
    const scope = projectKey.trim();
    if (!scope) continue;
    normalized[scope] = normalizeKeys(order);
  }
  return normalized;
}

function extractWorkspaceOrderScope(scopeKey: string): SidebarWorkspaceOrderScope | null {
  const separatorIndex = scopeKey.indexOf("::");
  if (separatorIndex < 0) return null;
  const serverId = scopeKey.slice(0, separatorIndex).trim();
  const projectKey = scopeKey.slice(separatorIndex + 2).trim();
  if (!serverId || !projectKey) return null;
  return { serverId, projectKey };
}

function normalizeLegacyWorkspaceKey(serverId: string, rawWorkspaceKey: string): string | null {
  const workspaceKey = rawWorkspaceKey.trim();
  if (!workspaceKey) return null;
  const serverPrefix = `${serverId}:`;
  return workspaceKey.startsWith(serverPrefix) ? workspaceKey : `${serverPrefix}${workspaceKey}`;
}

export function migrateSidebarOrderState(persistedState: unknown): {
  projectOrder: string[];
  workspaceOrderByProject: Record<string, string[]>;
} {
  const state = persistedState as SidebarOrderPersistedState | undefined;

  if (!state) {
    return { projectOrder: [], workspaceOrderByProject: {} };
  }

  const projectOrder = normalizeKeys(state.projectOrder ?? []);
  const seenProjects = new Set(projectOrder);
  for (const keys of Object.values(state.projectOrderByServerId ?? {})) {
    for (const key of normalizeKeys(keys)) {
      if (seenProjects.has(key)) continue;
      seenProjects.add(key);
      projectOrder.push(key);
    }
  }

  const workspaceOrderByProject = normalizeWorkspaceOrderByProject(state.workspaceOrderByProject);
  for (const [scopeKey, order] of Object.entries(state.workspaceOrderByServerAndProject ?? {})) {
    const scope = extractWorkspaceOrderScope(scopeKey);
    if (!scope) continue;
    const existing = workspaceOrderByProject[scope.projectKey] ?? [];
    const merged = [...existing];
    const seen = new Set(merged);
    for (const key of order) {
      const workspaceKey = normalizeLegacyWorkspaceKey(scope.serverId, key);
      if (!workspaceKey || seen.has(workspaceKey)) continue;
      seen.add(workspaceKey);
      merged.push(workspaceKey);
    }
    workspaceOrderByProject[scope.projectKey] = merged;
  }

  return { projectOrder, workspaceOrderByProject };
}

export const useSidebarOrderStore = create<SidebarOrderStoreState>()(
  persist(
    (set, get) => ({
      projectOrder: [],
      workspaceOrderByProject: {},
      getProjectOrder: () => get().projectOrder,
      setProjectOrder: (keys) => {
        const normalized = normalizeKeys(keys);
        set({ projectOrder: normalized });
      },
      getWorkspaceOrder: (projectKey) => {
        const scope = projectKey.trim();
        if (!scope) return [];
        return get().workspaceOrderByProject[scope] ?? [];
      },
      setWorkspaceOrder: (projectKey, keys) => {
        const scope = projectKey.trim();
        if (!scope) return;
        const normalized = normalizeKeys(keys);
        set((state) => ({
          workspaceOrderByProject: {
            ...state.workspaceOrderByProject,
            [scope]: normalized,
          },
        }));
      },
    }),
    {
      name: "sidebar-project-workspace-order",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        projectOrder: state.projectOrder,
        workspaceOrderByProject: state.workspaceOrderByProject,
      }),
      version: 1,
      migrate: migrateSidebarOrderState,
    },
  ),
);
