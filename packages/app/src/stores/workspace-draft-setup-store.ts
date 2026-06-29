import { create } from "zustand";
import type { WorkspaceDraftTabSetup } from "@/stores/workspace-tabs-store";

export interface PendingWorkspaceDraftSetup {
  setup: WorkspaceDraftTabSetup;
  sourceDirectory?: string | null;
}

interface WorkspaceDraftSetupState {
  setupByDraftId: Record<string, PendingWorkspaceDraftSetup>;
  setDraftSetup: (input: {
    draftId: string;
    setup: WorkspaceDraftTabSetup;
    sourceDirectory?: string | null;
  }) => void;
  clearDraftSetup: (input: { draftId: string }) => void;
}

function normalizeDraftId(draftId: string): string {
  return draftId.trim();
}

export const useWorkspaceDraftSetupStore = create<WorkspaceDraftSetupState>()((set) => ({
  setupByDraftId: {},
  setDraftSetup: ({ draftId, setup, sourceDirectory }) => {
    const normalizedDraftId = normalizeDraftId(draftId);
    if (!normalizedDraftId) {
      return;
    }
    set((state) => ({
      setupByDraftId: {
        ...state.setupByDraftId,
        [normalizedDraftId]: {
          setup,
          sourceDirectory: sourceDirectory ?? null,
        },
      },
    }));
  },
  clearDraftSetup: ({ draftId }) => {
    const normalizedDraftId = normalizeDraftId(draftId);
    if (!normalizedDraftId) {
      return;
    }
    set((state) => {
      if (!state.setupByDraftId[normalizedDraftId]) {
        return state;
      }
      const next = { ...state.setupByDraftId };
      delete next[normalizedDraftId];
      return { setupByDraftId: next };
    });
  },
}));

export function resetWorkspaceDraftSetupStore(): void {
  useWorkspaceDraftSetupStore.setState({ setupByDraftId: {} });
}
