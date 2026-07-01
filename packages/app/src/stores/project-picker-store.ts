import { create } from "zustand";

interface ProjectPickerRequest {
  serverId: string;
}

interface ProjectPickerStoreState {
  request: ProjectPickerRequest | null;
  open: (serverId: string) => void;
  close: () => void;
}

export const useProjectPickerStore = create<ProjectPickerStoreState>((set) => ({
  request: null,
  open: (serverId) => set({ request: { serverId } }),
  close: () => set({ request: null }),
}));
