import { create } from "zustand";

interface SettingsModalStore {
  visible: boolean;
  open: () => void;
  close: () => void;
}

export const useSettingsModalStore = create<SettingsModalStore>((set) => ({
  visible: false,
  open: () => set({ visible: true }),
  close: () => set({ visible: false }),
}));
