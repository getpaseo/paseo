import { create } from "zustand";

export interface SettingsAddHostFlowRequest {
  id: number;
}

interface SettingsAddHostFlowState {
  request: SettingsAddHostFlowRequest | null;
  open: () => void;
  close: () => void;
}

let nextRequestId = 1;

export const useSettingsAddHostFlowStore = create<SettingsAddHostFlowState>((set) => ({
  request: null,
  open: () => set({ request: { id: nextRequestId++ } }),
  close: () => set({ request: null }),
}));
