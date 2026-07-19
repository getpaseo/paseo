import { create } from "zustand";

interface AppDiagnosticState {
  visible: boolean;
  open: () => void;
  close: () => void;
}

export const useAppDiagnosticStore = create<AppDiagnosticState>((set) => ({
  visible: false,
  open: () => set({ visible: true }),
  close: () => set({ visible: false }),
}));
