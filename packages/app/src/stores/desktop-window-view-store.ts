import { create } from "zustand";

/**
 * What this window currently shows, published by independent subtrees so
 * `use-report-window-view.ts` can send one combined report to the desktop main
 * process. Not persisted — this is live per-window state, not a setting.
 *
 * `visibleAgentIds` is keyed by workspace persistence key rather than a single flat
 * list: a stacked navigator can keep more than one `WorkspaceScreen` mounted at once
 * (that's the whole reason `useIsFocused`/`routeFocused` exists), and each publishes
 * `[]` while unfocused. A flat "last write wins" slot would let a background screen's
 * re-render race the focused screen's and wipe its agent ids. Only the focused
 * workspace reports non-empty ids, so unioning every entry is always safe.
 *
 * `visibleWorkspaceKeys` is `null` while the sidebar isn't actively reporting (it is
 * inactive, or hasn't mounted yet), distinct from `[]` ("active, showing nothing").
 * `use-sidebar-workspace-entries.ts` deliberately keeps stale entries when disabled, so
 * treating "inactive" the same as "empty" would make a hidden sidebar claim it shows
 * nothing rather than not reporting at all — `buildWindowViewReport` needs that
 * distinction to avoid a false negative on tier 3.
 */
interface DesktopWindowViewState {
  visibleAgentIdsByWorkspace: ReadonlyMap<string, readonly string[]>;
  visibleWorkspaceKeys: readonly string[] | null;
  setVisibleAgentIds: (persistenceKey: string, ids: readonly string[]) => void;
  clearVisibleAgentIds: (persistenceKey: string) => void;
  setVisibleWorkspaceKeys: (keys: readonly string[] | null) => void;
}

export const useDesktopWindowViewStore = create<DesktopWindowViewState>((set) => ({
  visibleAgentIdsByWorkspace: new Map(),
  visibleWorkspaceKeys: null,
  setVisibleAgentIds: (persistenceKey, ids) =>
    set((state) => {
      const next = new Map(state.visibleAgentIdsByWorkspace);
      next.set(persistenceKey, ids);
      return { visibleAgentIdsByWorkspace: next };
    }),
  clearVisibleAgentIds: (persistenceKey) =>
    set((state) => {
      if (!state.visibleAgentIdsByWorkspace.has(persistenceKey)) {
        return state;
      }
      const next = new Map(state.visibleAgentIdsByWorkspace);
      next.delete(persistenceKey);
      return { visibleAgentIdsByWorkspace: next };
    }),
  setVisibleWorkspaceKeys: (keys) => set({ visibleWorkspaceKeys: keys }),
}));
