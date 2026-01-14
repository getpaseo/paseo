import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";

export interface DraftInput {
  text: string;
  images: Array<{ uri: string; mimeType: string }>;
}

interface DraftStoreState {
  drafts: Record<string, DraftInput>;
  createModalDraft: DraftInput | null;
}

interface DraftStoreActions {
  getDraftInput: (agentId: string) => DraftInput | undefined;
  saveDraftInput: (agentId: string, draft: DraftInput) => void;
  clearDraftInput: (agentId: string) => void;
  getCreateModalDraft: () => DraftInput | null;
  saveCreateModalDraft: (draft: DraftInput | null) => void;
}

type DraftStore = DraftStoreState & DraftStoreActions;

export const useDraftStore = create<DraftStore>()(
  persist(
    (set, get) => ({
      drafts: {},
      createModalDraft: null,

      getDraftInput: (agentId) => {
        return get().drafts[agentId];
      },

      saveDraftInput: (agentId, draft) => {
        set((state) => ({
          drafts: {
            ...state.drafts,
            [agentId]: draft,
          },
        }));
      },

      clearDraftInput: (agentId) => {
        set((state) => {
          const { [agentId]: _, ...rest } = state.drafts;
          return { drafts: rest };
        });
      },

      getCreateModalDraft: () => {
        return get().createModalDraft;
      },

      saveCreateModalDraft: (draft) => {
        set({ createModalDraft: draft });
      },
    }),
    {
      name: "paseo-drafts",
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);
