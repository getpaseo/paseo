import { create } from "zustand";

export interface ProjectGroupCreateRequest {
  id: number;
  preselectedViewKeys: readonly string[];
}

interface ProjectGroupCreateModalStoreState {
  request: ProjectGroupCreateRequest | null;
  open: (preselectedViewKeys?: readonly string[]) => void;
  /** Closes only the request it was handed, so a stale callback cannot close a newer open. */
  close: (requestId: number) => void;
}

let nextRequestId = 1;

export const useProjectGroupCreateModalStore = create<ProjectGroupCreateModalStoreState>((set) => ({
  request: null,
  open: (preselectedViewKeys = []) => {
    set({ request: { id: nextRequestId++, preselectedViewKeys } });
  },
  close: (requestId) =>
    set((state) => (state.request?.id === requestId ? { request: null } : state)),
}));

/** Imperative opener for callers outside a component that already holds the store's hook. */
export function openProjectGroupCreateModal(preselectedViewKeys?: readonly string[]): void {
  useProjectGroupCreateModalStore.getState().open(preselectedViewKeys);
}
