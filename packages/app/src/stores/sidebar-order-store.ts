import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface SidebarOrderStoreState {
  projectOrderByServerId: Record<string, string[]>;
  workspaceOrderByServerAndProject: Record<string, string[]>;
  getProjectOrder: (serverId: string) => string[];
  setProjectOrder: (serverId: string, keys: string[]) => void;
  getWorkspaceOrder: (serverId: string, projectKey: string) => string[];
  setWorkspaceOrder: (serverId: string, projectKey: string, keys: string[]) => void;
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

export function buildSidebarWorkspaceOrderScopeKey(serverId: string, projectKey: string): string {
  return `${serverId.trim()}::${projectKey.trim()}`;
}

export const useSidebarOrderStore = create<SidebarOrderStoreState>()(
  persist(
    (set, get) => ({
      projectOrderByServerId: {},
      workspaceOrderByServerAndProject: {},
      getProjectOrder: (serverId) => {
        const key = serverId.trim();
        if (!key) {
          return [];
        }
        return get().projectOrderByServerId[key] ?? [];
      },
      setProjectOrder: (serverId, keys) => {
        const key = serverId.trim();
        if (!key) {
          return;
        }
        const normalized = normalizeKeys(keys);
        set((state) => ({
          projectOrderByServerId: {
            ...state.projectOrderByServerId,
            [key]: normalized,
          },
        }));
      },
      getWorkspaceOrder: (serverId, projectKey) => {
        const serverKey = serverId.trim();
        const projectScope = projectKey.trim();
        if (!serverKey || !projectScope) {
          return [];
        }
        const scopeKey = buildSidebarWorkspaceOrderScopeKey(serverKey, projectScope);
        return get().workspaceOrderByServerAndProject[scopeKey] ?? [];
      },
      setWorkspaceOrder: (serverId, projectKey, keys) => {
        const serverKey = serverId.trim();
        const projectScope = projectKey.trim();
        if (!serverKey || !projectScope) {
          return;
        }
        const scopeKey = buildSidebarWorkspaceOrderScopeKey(serverKey, projectScope);
        const normalized = normalizeKeys(keys);
        set((state) => ({
          workspaceOrderByServerAndProject: {
            ...state.workspaceOrderByServerAndProject,
            [scopeKey]: normalized,
          },
        }));
      },
    }),
    {
      name: "sidebar-project-workspace-order",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        projectOrderByServerId: state.projectOrderByServerId,
        workspaceOrderByServerAndProject: state.workspaceOrderByServerAndProject,
      }),
    },
  ),
);
