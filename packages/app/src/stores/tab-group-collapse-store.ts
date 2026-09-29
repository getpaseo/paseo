import { create } from "zustand";

interface TabGroupCollapseState {
  /** Collapsed group keys per workspace (`serverId:workspaceId`). */
  collapsed: Record<string, string[]>;
  toggle: (scopeKey: string, groupKey: string) => void;
}

// ponytail: in memory only; persist it if people want collapsed groups to survive a restart.
export const useTabGroupCollapseStore = create<TabGroupCollapseState>((set) => ({
  collapsed: {},
  toggle: (scopeKey, groupKey) =>
    set((state) => {
      const current = state.collapsed[scopeKey] ?? [];
      const next = current.includes(groupKey)
        ? current.filter((key) => key !== groupKey)
        : [...current, groupKey];
      return { collapsed: { ...state.collapsed, [scopeKey]: next } };
    }),
}));
