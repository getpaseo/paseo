import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  buildDeterministicWorkspaceTabId,
  normalizeWorkspaceTabTarget,
  workspaceTabTargetsEqual,
} from "@/utils/workspace-tab-identity";

export type WorkspaceTabTarget =
  | { kind: "draft"; draftId: string }
  | { kind: "agent"; agentId: string }
  | { kind: "terminal"; terminalId: string }
  | { kind: "file"; path: string }
  | { kind: "setup"; workspaceId: string };

export type WorkspaceTab = {
  tabId: string;
  target: WorkspaceTabTarget;
  createdAt: number;
};

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildWorkspaceTabPersistenceKey(input: {
  serverId: string;
  workspaceId: string;
}): string | null {
  const serverId = trimNonEmpty(input.serverId);
  const workspaceId = trimNonEmpty(input.workspaceId);
  if (!serverId || !workspaceId) {
    return null;
  }
  return `${serverId}:${workspaceId}`;
}

function normalizeTabOrder(list: unknown): string[] {
  if (!Array.isArray(list)) {
    return [];
  }
  const next: string[] = [];
  const used = new Set<string>();
  for (const value of list) {
    const tabId = trimNonEmpty(typeof value === "string" ? value : null);
    if (!tabId || used.has(tabId)) {
      continue;
    }
    used.add(tabId);
    next.push(tabId);
  }
  return next;
}

function ensureInOrder(input: { current: string[]; tabId: string }): string[] {
  if (input.current.includes(input.tabId)) {
    return input.current;
  }
  return [...input.current, input.tabId];
}

type WorkspaceTabsState = {
  uiTabsByWorkspace: Record<string, WorkspaceTab[]>;
  tabOrderByWorkspace: Record<string, string[]>;
  focusedTabIdByWorkspace: Record<string, string>;
  openDraftTab: (input: {
    serverId: string;
    workspaceId: string;
    draftId: string;
  }) => string | null;
  ensureTab: (input: {
    serverId: string;
    workspaceId: string;
    target: WorkspaceTabTarget;
  }) => string | null;
  openOrFocusTab: (input: {
    serverId: string;
    workspaceId: string;
    target: WorkspaceTabTarget;
  }) => string | null;
  focusTab: (input: { serverId: string; workspaceId: string; tabId: string }) => void;
  closeTab: (input: { serverId: string; workspaceId: string; tabId: string }) => void;
  retargetTab: (input: {
    serverId: string;
    workspaceId: string;
    tabId: string;
    target: WorkspaceTabTarget;
  }) => string | null;
  reorderTabs: (input: { serverId: string; workspaceId: string; tabIds: string[] }) => void;
  getWorkspaceTabs: (input: { serverId: string; workspaceId: string }) => WorkspaceTab[];
  purgeWorkspace: (input: { serverId: string; workspaceId: string }) => void;
};

export const useWorkspaceTabsStore = create<WorkspaceTabsState>()(
  persist(
    (set, get) => ({
      uiTabsByWorkspace: {},
      tabOrderByWorkspace: {},
      focusedTabIdByWorkspace: {},
      openDraftTab: ({ serverId, workspaceId, draftId }) => {
        const normalizedDraftId = trimNonEmpty(draftId);
        if (!normalizedDraftId) {
          return null;
        }
        return get().openOrFocusTab({
          serverId,
          workspaceId,
          target: { kind: "draft", draftId: normalizedDraftId },
        });
      },
      ensureTab: ({ serverId, workspaceId, target }) => {
        const key = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
        const normalizedTarget = normalizeWorkspaceTabTarget(target);
        if (!key || !normalizedTarget) {
          return null;
        }

        const deterministicTabId = buildDeterministicWorkspaceTabId(normalizedTarget);
        let resolvedTabId = deterministicTabId;
        const now = Date.now();

        set((state) => {
          const currentTabs = state.uiTabsByWorkspace[key] ?? [];
          const tabWithSameTarget =
            currentTabs.find((tab) => workspaceTabTargetsEqual(tab.target, normalizedTarget)) ??
            null;
          const effectiveTabId = tabWithSameTarget?.tabId ?? deterministicTabId;
          resolvedTabId = effectiveTabId;

          const currentOrder = state.tabOrderByWorkspace[key] ?? [];
          const nextOrder = ensureInOrder({ current: currentOrder, tabId: effectiveTabId });
          const existingIndex = currentTabs.findIndex((tab) => tab.tabId === effectiveTabId);
          const nextTabs = (() => {
            if (existingIndex < 0) {
              return [
                ...currentTabs,
                { tabId: effectiveTabId, target: normalizedTarget, createdAt: now },
              ];
            }
            const existing = currentTabs[existingIndex];
            if (existing && workspaceTabTargetsEqual(existing.target, normalizedTarget)) {
              return currentTabs;
            }
            return currentTabs.map((tab, index) =>
              index === existingIndex ? { ...tab, target: normalizedTarget } : tab,
            );
          })();

          return {
            uiTabsByWorkspace:
              nextTabs === currentTabs
                ? state.uiTabsByWorkspace
                : { ...state.uiTabsByWorkspace, [key]: nextTabs },
            tabOrderByWorkspace:
              nextOrder === currentOrder
                ? state.tabOrderByWorkspace
                : { ...state.tabOrderByWorkspace, [key]: nextOrder },
          };
        });

        return resolvedTabId;
      },
      openOrFocusTab: ({ serverId, workspaceId, target }) => {
        const tabId = get().ensureTab({ serverId, workspaceId, target });
        if (!tabId) {
          return null;
        }
        get().focusTab({ serverId, workspaceId, tabId });
        return tabId;
      },
      focusTab: ({ serverId, workspaceId, tabId }) => {
        const key = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
        const normalizedTabId = trimNonEmpty(tabId);
        if (!key || !normalizedTabId) {
          return;
        }
        set((state) => {
          if (state.focusedTabIdByWorkspace[key] === normalizedTabId) {
            return state;
          }
          return {
            ...state,
            focusedTabIdByWorkspace: {
              ...state.focusedTabIdByWorkspace,
              [key]: normalizedTabId,
            },
          };
        });
      },
      closeTab: ({ serverId, workspaceId, tabId }) => {
        const key = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
        const normalizedTabId = trimNonEmpty(tabId);
        if (!key || !normalizedTabId) {
          return;
        }

        set((state) => {
          const currentTabs = state.uiTabsByWorkspace[key] ?? [];
          const nextTabs = currentTabs.filter((tab) => tab.tabId !== normalizedTabId);
          const currentOrder = state.tabOrderByWorkspace[key] ?? [];
          const nextOrder = currentOrder.filter((value) => value !== normalizedTabId);

          const nextUiTabsByWorkspace =
            nextTabs.length === 0
              ? (() => {
                  const { [key]: _removed, ...rest } = state.uiTabsByWorkspace;
                  return rest;
                })()
              : nextTabs.length === currentTabs.length
                ? state.uiTabsByWorkspace
                : { ...state.uiTabsByWorkspace, [key]: nextTabs };

          const nextTabOrderByWorkspace =
            nextOrder.length === 0
              ? (() => {
                  const { [key]: _removed, ...rest } = state.tabOrderByWorkspace;
                  return rest;
                })()
              : nextOrder.length === currentOrder.length
                ? state.tabOrderByWorkspace
                : { ...state.tabOrderByWorkspace, [key]: nextOrder };

          const currentFocused = state.focusedTabIdByWorkspace[key] ?? null;
          const nextFocused =
            currentFocused !== normalizedTabId
              ? currentFocused
              : (nextOrder[nextOrder.length - 1] ?? null);
          const nextFocusedByWorkspace = (() => {
            if (!nextFocused) {
              const { [key]: _removed, ...rest } = state.focusedTabIdByWorkspace;
              return rest;
            }
            return { ...state.focusedTabIdByWorkspace, [key]: nextFocused };
          })();

          const tabsChanged = nextTabs.length !== currentTabs.length;
          const orderChanged = nextOrder.length !== currentOrder.length;
          const focusChanged =
            (state.focusedTabIdByWorkspace[key] ?? null) !== (nextFocusedByWorkspace[key] ?? null);

          if (!tabsChanged && !orderChanged && !focusChanged) {
            return state;
          }

          return {
            uiTabsByWorkspace: nextUiTabsByWorkspace,
            tabOrderByWorkspace: nextTabOrderByWorkspace,
            focusedTabIdByWorkspace: nextFocusedByWorkspace,
          };
        });
      },
      retargetTab: ({ serverId, workspaceId, tabId, target }) => {
        const key = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
        const normalizedTabId = trimNonEmpty(tabId);
        const normalizedTarget = normalizeWorkspaceTabTarget(target);
        if (!key || !normalizedTabId || !normalizedTarget) {
          return null;
        }

        let retargetedTabId: string | null = null;

        set((state) => {
          const currentTabs = state.uiTabsByWorkspace[key] ?? [];
          const index = currentTabs.findIndex((tab) => tab.tabId === normalizedTabId);
          if (index < 0) {
            return state;
          }

          const currentTarget = currentTabs[index]?.target;
          if (currentTarget && workspaceTabTargetsEqual(currentTarget, normalizedTarget)) {
            return state;
          }

          const nextTabs = currentTabs.map((tab, tabIndex) =>
            tabIndex === index ? { ...tab, target: normalizedTarget } : tab,
          );
          retargetedTabId = normalizedTabId;
          return {
            uiTabsByWorkspace: { ...state.uiTabsByWorkspace, [key]: nextTabs },
            tabOrderByWorkspace: state.tabOrderByWorkspace,
            focusedTabIdByWorkspace: state.focusedTabIdByWorkspace,
          };
        });

        return retargetedTabId;
      },
      reorderTabs: ({ serverId, workspaceId, tabIds }) => {
        const key = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
        if (!key) {
          return;
        }

        const normalized = normalizeTabOrder(tabIds);
        set((state) => {
          const current = state.tabOrderByWorkspace[key] ?? [];
          if (current.length === normalized.length) {
            let same = true;
            for (let i = 0; i < current.length; i += 1) {
              if (current[i] !== normalized[i]) {
                same = false;
                break;
              }
            }
            if (same) {
              return state;
            }
          }

          return {
            ...state,
            tabOrderByWorkspace: {
              ...state.tabOrderByWorkspace,
              [key]: normalized,
            },
          };
        });
      },
      getWorkspaceTabs: ({ serverId, workspaceId }) => {
        const key = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
        if (!key) {
          return [];
        }
        return get().uiTabsByWorkspace[key] ?? [];
      },
      purgeWorkspace: ({ serverId, workspaceId }) => {
        const key = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
        if (!key) {
          return;
        }
        set((state) => {
          if (
            !(key in state.uiTabsByWorkspace) &&
            !(key in state.tabOrderByWorkspace) &&
            !(key in state.focusedTabIdByWorkspace)
          ) {
            return state;
          }
          const { [key]: _tabs, ...remainingUiTabsByWorkspace } = state.uiTabsByWorkspace;
          const { [key]: _order, ...remainingTabOrderByWorkspace } = state.tabOrderByWorkspace;
          const { [key]: _focused, ...remainingFocusedTabIdByWorkspace } =
            state.focusedTabIdByWorkspace;
          return {
            ...state,
            uiTabsByWorkspace: remainingUiTabsByWorkspace,
            tabOrderByWorkspace: remainingTabOrderByWorkspace,
            focusedTabIdByWorkspace: remainingFocusedTabIdByWorkspace,
          };
        });
      },
    }),
    {
      name: "workspace-tabs-state",
      version: 5,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => {
        const nextUiTabsByWorkspace: Record<string, WorkspaceTab[]> = {};
        for (const key in state.uiTabsByWorkspace) {
          const tabs = (state.uiTabsByWorkspace[key] ?? [])
            .map((tab) => {
              const normalizedTarget = normalizeWorkspaceTabTarget(tab.target);
              const normalizedTabId = trimNonEmpty(tab.tabId);
              if (!normalizedTarget || !normalizedTabId) {
                return null;
              }
              return {
                tabId: normalizedTabId,
                target: normalizedTarget,
                createdAt: typeof tab.createdAt === "number" ? tab.createdAt : Date.now(),
              } satisfies WorkspaceTab;
            })
            .filter((tab): tab is WorkspaceTab => tab !== null);
          if (tabs.length > 0) {
            nextUiTabsByWorkspace[key] = tabs;
          }
        }

        const nextTabOrderByWorkspace: Record<string, string[]> = {};
        for (const key in state.tabOrderByWorkspace) {
          const order = normalizeTabOrder(state.tabOrderByWorkspace[key]);
          if (order.length > 0) {
            nextTabOrderByWorkspace[key] = order;
          }
        }

        const nextFocusedTabIdByWorkspace: Record<string, string> = {};
        for (const key in state.focusedTabIdByWorkspace) {
          const focusedTabId = trimNonEmpty(state.focusedTabIdByWorkspace[key]);
          if (focusedTabId) {
            nextFocusedTabIdByWorkspace[key] = focusedTabId;
          }
        }

        return {
          uiTabsByWorkspace: nextUiTabsByWorkspace,
          tabOrderByWorkspace: nextTabOrderByWorkspace,
          focusedTabIdByWorkspace: nextFocusedTabIdByWorkspace,
        };
      },
      migrate: (persistedState) => {
        const legacy = persistedState as
          | {
              version?: number;
              state?: any;
              openTabsByWorkspace?: Record<string, WorkspaceTab[]>;
              uiTabsByWorkspace?: Record<string, WorkspaceTab[]>;
              focusedTabIdByWorkspace?: Record<string, string>;
              tabOrderByWorkspace?: Record<string, string[]>;
              lastFocusedTabByWorkspace?: Record<string, any>;
              tabOrderLegacyByWorkspace?: Record<string, string[]>;
            }
          | undefined;

        const rawState = (legacy as any)?.state ?? legacy ?? {};

        const rawUiTabsByWorkspace =
          rawState.uiTabsByWorkspace ??
          rawState.openTabsByWorkspace ??
          legacy?.uiTabsByWorkspace ??
          legacy?.openTabsByWorkspace ??
          {};
        const rawFocused =
          rawState.focusedTabIdByWorkspace ??
          legacy?.focusedTabIdByWorkspace ??
          rawState.lastFocusedTabByWorkspace ??
          {};
        const rawOrder =
          rawState.tabOrderByWorkspace ??
          legacy?.tabOrderByWorkspace ??
          rawState.tabOrderByWorkspace ??
          {};
        const legacyOrder =
          rawState.tabOrderByWorkspace ?? rawState.tabOrderLegacyByWorkspace ?? {};

        const uiTabsByWorkspace: Record<string, WorkspaceTab[]> = {};
        const tabOrderByWorkspace: Record<string, string[]> = {};
        const focusedTabIdByWorkspace: Record<string, string> = {};

        for (const key in rawUiTabsByWorkspace) {
          const entries = Array.isArray(rawUiTabsByWorkspace[key]) ? rawUiTabsByWorkspace[key] : [];
          const nextUiTabs: WorkspaceTab[] = [];
          const orderFromTabs: string[] = [];
          const usedOrder = new Set<string>();

          for (const rawTab of entries) {
            if (!rawTab || typeof rawTab !== "object") {
              continue;
            }

            const normalizedTarget = normalizeWorkspaceTabTarget((rawTab as WorkspaceTab).target);
            const rawTabId = trimNonEmpty((rawTab as WorkspaceTab).tabId);
            if (!normalizedTarget) {
              continue;
            }

            const tabId = rawTabId ?? buildDeterministicWorkspaceTabId(normalizedTarget);
            if (!usedOrder.has(tabId)) {
              usedOrder.add(tabId);
              orderFromTabs.push(tabId);
            }

            nextUiTabs.push({
              tabId,
              target: normalizedTarget,
              createdAt:
                typeof (rawTab as WorkspaceTab).createdAt === "number"
                  ? (rawTab as WorkspaceTab).createdAt
                  : Date.now(),
            });
          }

          if (nextUiTabs.length > 0) {
            uiTabsByWorkspace[key] = nextUiTabs;
          }
          if (orderFromTabs.length > 0) {
            tabOrderByWorkspace[key] = orderFromTabs;
          }
        }

        for (const key in rawOrder) {
          const normalizedOrder = normalizeTabOrder(rawOrder[key]);
          if (normalizedOrder.length === 0) {
            continue;
          }
          const existing = tabOrderByWorkspace[key] ?? [];
          tabOrderByWorkspace[key] = normalizeTabOrder([...existing, ...normalizedOrder]);
        }

        for (const key in legacyOrder) {
          const list = legacyOrder[key];
          if (!Array.isArray(list) || list.length === 0) {
            continue;
          }
          const normalizedLegacyOrder: string[] = [];
          for (const entry of list) {
            const raw = typeof entry === "string" ? entry.trim() : "";
            if (!raw) {
              continue;
            }
            if (raw.startsWith("agent:")) {
              const agentId = raw.slice("agent:".length).trim();
              if (agentId) {
                normalizedLegacyOrder.push(`agent_${agentId}`);
              }
              continue;
            }
            if (raw.startsWith("terminal:")) {
              const terminalId = raw.slice("terminal:".length).trim();
              if (terminalId) {
                normalizedLegacyOrder.push(`terminal_${terminalId}`);
              }
            }
          }
          if (normalizedLegacyOrder.length === 0) {
            continue;
          }
          const existing = tabOrderByWorkspace[key] ?? [];
          tabOrderByWorkspace[key] = normalizeTabOrder([...existing, ...normalizedLegacyOrder]);
        }

        for (const key in rawFocused) {
          const value = rawFocused[key];
          if (typeof value === "string") {
            const normalized = trimNonEmpty(value);
            if (normalized) {
              focusedTabIdByWorkspace[key] = normalized;
            }
            continue;
          }
          if (!value || typeof value !== "object" || typeof value.kind !== "string") {
            continue;
          }
          if (value.kind === "agent" && typeof value.agentId === "string" && value.agentId.trim()) {
            focusedTabIdByWorkspace[key] = `agent_${value.agentId.trim()}`;
            continue;
          }
          if (
            value.kind === "terminal" &&
            typeof value.terminalId === "string" &&
            value.terminalId.trim()
          ) {
            focusedTabIdByWorkspace[key] = `terminal_${value.terminalId.trim()}`;
            continue;
          }
          if (value.kind === "draft" && typeof value.draftId === "string" && value.draftId.trim()) {
            focusedTabIdByWorkspace[key] = value.draftId.trim();
          }
        }

        return {
          uiTabsByWorkspace,
          tabOrderByWorkspace,
          focusedTabIdByWorkspace,
        };
      },
    },
  ),
);
