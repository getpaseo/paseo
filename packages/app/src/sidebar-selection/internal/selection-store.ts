import { create } from "zustand";
import {
  enterWorkspaceSelection,
  exitWorkspaceSelection,
  INITIAL_WORKSPACE_SELECTION_STATE,
  reconcileWorkspaceSelection,
  selectWorkspaceRange,
  toggleWorkspaceSelection,
  type WorkspaceSelectionState,
} from "./selection-state";

type VisibleKeysReader = () => readonly string[];

let visibleKeysReader: VisibleKeysReader = () => [];

/**
 * Registers a synchronous reader for the currently rendered sidebar workspace order so Shift+click
 * range selection walks only rows on screen without causing re-renders when the order changes.
 */
export function registerSidebarVisibleWorkspaceKeysReader(reader: VisibleKeysReader): () => void {
  visibleKeysReader = reader;
  return () => {
    if (visibleKeysReader === reader) {
      visibleKeysReader = () => [];
    }
  };
}

interface SidebarSelectionStoreState extends WorkspaceSelectionState {
  isArchiving: boolean;
  enter: (workspaceKey: string) => void;
  pressWorkspace: (workspaceKey: string, options: { shiftKey: boolean }) => void;
  reconcile: (availableKeys: ReadonlySet<string>) => void;
  setArchiving: (archiving: boolean) => void;
  exit: () => void;
}

export const useSidebarSelectionStore = create<SidebarSelectionStoreState>((set) => ({
  ...INITIAL_WORKSPACE_SELECTION_STATE,
  isArchiving: false,
  enter: (workspaceKey) =>
    set(() => ({
      ...enterWorkspaceSelection(workspaceKey),
      isArchiving: false,
    })),
  pressWorkspace: (workspaceKey, { shiftKey }) =>
    set((state) => {
      if (state.isArchiving) return state;
      const next = shiftKey
        ? selectWorkspaceRange(state, workspaceKey, visibleKeysReader())
        : toggleWorkspaceSelection(state, workspaceKey);
      return next === state ? state : { ...next };
    }),
  reconcile: (availableKeys) =>
    set((state) => {
      const next = reconcileWorkspaceSelection(state, availableKeys);
      return next === state ? state : { ...next };
    }),
  setArchiving: (isArchiving) => set({ isArchiving }),
  exit: () =>
    set((state) =>
      state.active || state.isArchiving
        ? { ...exitWorkspaceSelection(), isArchiving: false }
        : state,
    ),
}));

export function useIsSidebarSelectionMode(): boolean {
  return useSidebarSelectionStore((state) => state.active);
}

export function useIsWorkspaceBulkSelected(workspaceKey: string): boolean {
  return useSidebarSelectionStore((state) => state.active && state.selectedKeys.has(workspaceKey));
}

export function useSidebarSelectionCount(): number {
  return useSidebarSelectionStore((state) => (state.active ? state.selectedKeys.size : 0));
}

export function useSidebarSelectionArchiving(): boolean {
  return useSidebarSelectionStore((state) => state.isArchiving);
}
