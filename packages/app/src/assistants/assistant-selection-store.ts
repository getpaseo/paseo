import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * Which assistant the global launcher addresses on each host.
 *
 * Keyed by server id because assistants live on the daemon that owns them: the
 * same name on two hosts is two different records. Only the id is stored;
 * the record itself is fetched, and a selection whose assistant no longer
 * exists is dropped by `reconcile` the next time the list loads.
 */
interface AssistantSelectionState {
  selectedByServerId: Record<string, string>;
  select: (serverId: string, assistantId: string | null) => void;
  reconcile: (serverId: string, existingAssistantIds: readonly string[]) => void;
}

export const useAssistantSelectionStore = create<AssistantSelectionState>()(
  persist(
    (set) => ({
      selectedByServerId: {},
      select: (serverId, assistantId) =>
        set((state) => {
          const next = { ...state.selectedByServerId };
          if (assistantId) {
            next[serverId] = assistantId;
          } else {
            delete next[serverId];
          }
          return { selectedByServerId: next };
        }),
      reconcile: (serverId, existingAssistantIds) =>
        set((state) => {
          const selected = state.selectedByServerId[serverId];
          if (!selected || existingAssistantIds.includes(selected)) {
            return state;
          }
          const next = { ...state.selectedByServerId };
          delete next[serverId];
          return { selectedByServerId: next };
        }),
    }),
    {
      name: "paseo-assistant-selection",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ selectedByServerId: state.selectedByServerId }),
    },
  ),
);

/** Read outside React: the Live Voice runtime starts calls from event handlers. */
export function getSelectedAssistantId(serverId: string): string | null {
  return useAssistantSelectionStore.getState().selectedByServerId[serverId] ?? null;
}

export function useSelectedAssistantId(serverId: string | null): string | null {
  return useAssistantSelectionStore((state) =>
    serverId ? (state.selectedByServerId[serverId] ?? null) : null,
  );
}
