import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface InteractionLockState {
  locked: boolean;
  setLocked: (locked: boolean) => void;
  toggle: () => void;
}

export const useInteractionLockStore = create<InteractionLockState>()(
  persist(
    (set, get) => ({
      locked: false,
      setLocked: (locked) => set({ locked }),
      toggle: () => set({ locked: !get().locked }),
    }),
    {
      name: "@paseo:interaction-lock",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ locked: state.locked }),
    },
  ),
);

export function useInteractionLocked(): boolean {
  return useInteractionLockStore((state) => state.locked);
}
