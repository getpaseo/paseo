import { create } from "zustand";

interface ChangelogVisibility {
  visible: boolean;
  open: () => void;
  close: () => void;
}

export const useChangelogStore = create<ChangelogVisibility>((set) => ({
  visible: false,
  open: () => set({ visible: true }),
  close: () => set({ visible: false }),
}));
