import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

const sidebarProjectPinsPersistedStateSchema = z.object({
  pinnedProjectKeys: z.array(z.string()).optional(),
});

type SidebarProjectPinsPersistedState = z.infer<typeof sidebarProjectPinsPersistedStateSchema>;

interface SidebarProjectPinsStoreState {
  pinnedProjectKeys: string[];
  toggleProjectPinned: (projectViewKey: string) => void;
}

export function toggleProjectPinKey(keys: readonly string[], projectViewKey: string): string[] {
  if (!projectViewKey.trim()) return [...keys];
  if (keys.includes(projectViewKey)) {
    return keys.filter((key) => key !== projectViewKey);
  }
  return [...keys, projectViewKey];
}

export const useSidebarProjectPinsStore = create<SidebarProjectPinsStoreState>()(
  persist(
    (set) => ({
      pinnedProjectKeys: [],
      toggleProjectPinned: (projectViewKey) => {
        set((state) => ({
          pinnedProjectKeys: toggleProjectPinKey(state.pinnedProjectKeys, projectViewKey),
        }));
      },
    }),
    {
      name: "sidebar-project-pins",
      storage: createValidatedPersistStorage(AsyncStorage, sidebarProjectPinsPersistedStateSchema),
      partialize: (state): SidebarProjectPinsPersistedState => ({
        pinnedProjectKeys: state.pinnedProjectKeys,
      }),
      version: 1,
    },
  ),
);

export function useSidebarProjectPin(projectViewKey: string): {
  isPinned: boolean;
  togglePinned: () => void;
} {
  const isPinned = useSidebarProjectPinsStore((state) =>
    state.pinnedProjectKeys.includes(projectViewKey),
  );
  const toggleProjectPinned = useSidebarProjectPinsStore((state) => state.toggleProjectPinned);
  const togglePinned = useCallback(
    () => toggleProjectPinned(projectViewKey),
    [projectViewKey, toggleProjectPinned],
  );
  return { isPinned, togglePinned };
}
