import { create } from "zustand";

export type SettingsAddHostStep = "method" | "direct" | "remote-ssh" | "paste-link";

interface SettingsAddHostFlowState {
  step: SettingsAddHostStep | null;
  open: () => void;
  goTo: (step: SettingsAddHostStep) => void;
  close: () => void;
}

export const useSettingsAddHostFlowStore = create<SettingsAddHostFlowState>((set) => ({
  step: null,
  open: () => set({ step: "method" }),
  goTo: (step) => set({ step }),
  close: () => set({ step: null }),
}));

export function openSettingsAddHostFlow(): void {
  useSettingsAddHostFlowStore.getState().open();
}
