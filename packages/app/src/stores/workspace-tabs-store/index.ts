import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  applyCloseTab,
  applyEnsureTab,
  applyFocusTab,
  applyOpenDraftTab,
  applyOpenOrFocusTab,
  applyPurgeWorkspace,
  applyReorderTabs,
  applyRetargetTab,
  initialWorkspaceTabsCoreState,
  migrateWorkspaceTabsState,
  partializeWorkspaceTabsState,
  selectWorkspaceTabs,
  type WorkspaceTab,
  type WorkspaceTabsCoreState,
  type WorkspaceTabTarget,
} from "./state";

export { buildWorkspaceTabPersistenceKey } from "./state";
export type { WorkspaceDraftTabSetup, WorkspaceTab, WorkspaceTabTarget } from "./state";

interface WorkspaceTabsState extends WorkspaceTabsCoreState {
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
}

export const useWorkspaceTabsStore = create<WorkspaceTabsState>()(
  persist(
    (set, get) => ({
      ...initialWorkspaceTabsCoreState,
      openDraftTab: ({ serverId, workspaceId, draftId }) => {
        let resolved: string | null = null;
        set((state) => {
          const result = applyOpenDraftTab(state, {
            serverId,
            workspaceId,
            draftId,
            now: Date.now(),
          });
          resolved = result.tabId;
          return result.state;
        });
        return resolved;
      },
      ensureTab: ({ serverId, workspaceId, target }) => {
        let resolved: string | null = null;
        set((state) => {
          const result = applyEnsureTab(state, {
            serverId,
            workspaceId,
            target,
            now: Date.now(),
          });
          resolved = result.tabId;
          return result.state;
        });
        return resolved;
      },
      openOrFocusTab: ({ serverId, workspaceId, target }) => {
        let resolved: string | null = null;
        set((state) => {
          const result = applyOpenOrFocusTab(state, {
            serverId,
            workspaceId,
            target,
            now: Date.now(),
          });
          resolved = result.tabId;
          return result.state;
        });
        return resolved;
      },
      focusTab: (input) => set((state) => applyFocusTab(state, input)),
      closeTab: (input) => set((state) => applyCloseTab(state, input)),
      retargetTab: ({ serverId, workspaceId, tabId, target }) => {
        let resolved: string | null = null;
        set((state) => {
          const result = applyRetargetTab(state, { serverId, workspaceId, tabId, target });
          resolved = result.tabId;
          return result.state;
        });
        return resolved;
      },
      reorderTabs: (input) => set((state) => applyReorderTabs(state, input)),
      getWorkspaceTabs: (input) => selectWorkspaceTabs(get(), input),
      purgeWorkspace: (input) => set((state) => applyPurgeWorkspace(state, input)),
    }),
    {
      name: "workspace-tabs-state",
      version: 5,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => partializeWorkspaceTabsState(state, { now: Date.now() }),
      migrate: (persistedState) =>
        migrateWorkspaceTabsState(persistedState, { now: Date.now() }) as WorkspaceTabsState,
    },
  ),
);
