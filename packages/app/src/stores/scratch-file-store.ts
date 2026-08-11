import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface ScratchFileStore {
  contentsByKey: Record<string, string>;
  setContent: (key: string, content: string) => void;
  removeContent: (key: string) => void;
}

export function buildScratchFileStorageKey(input: {
  serverId: string;
  workspaceId: string;
  tabId: string;
}): string {
  return `${input.serverId.trim()}:${input.workspaceId.trim()}:${input.tabId.trim()}`;
}

export const useScratchFileStore = create<ScratchFileStore>()(
  persist(
    (set) => ({
      contentsByKey: {},
      setContent: (key, content) => {
        if (!key) return;
        set((state) => {
          if (state.contentsByKey[key] === content) {
            return state;
          }
          return {
            contentsByKey: {
              ...state.contentsByKey,
              [key]: content,
            },
          };
        });
      },
      removeContent: (key) => {
        if (!key) return;
        set((state) => {
          if (!(key in state.contentsByKey)) {
            return state;
          }
          const { [key]: _removed, ...contentsByKey } = state.contentsByKey;
          return { contentsByKey };
        });
      },
    }),
    {
      name: "scratch-file-state",
      version: 1,
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
