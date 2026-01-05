import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

interface SidebarState {
  isOpen: boolean;
  toggle: () => void;
  open: () => void;
  close: () => void;
}

const DEFAULT_OPEN = Platform.OS === "web";

export const useSidebarStore = create<SidebarState>()(
  persist(
    (set) => ({
      isOpen: DEFAULT_OPEN,
      toggle: () => set((state) => ({ isOpen: !state.isOpen })),
      open: () => set({ isOpen: true }),
      close: () => set({ isOpen: false }),
    }),
    {
      name: "sidebar-state",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ isOpen: state.isOpen }),
    }
  )
);

export function useSidebar() {
  return useSidebarStore();
}
