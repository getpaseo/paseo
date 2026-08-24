import { create } from "zustand";

export interface AddProjectFlowRequest {
  id: number;
  preferredHostId?: string;
}

interface AddProjectFlowStoreState {
  request: AddProjectFlowRequest | null;
  open: (preferredHostId?: string) => void;
  close: () => void;
}

let nextRequestId = 1;

export const useAddProjectFlowStore = create<AddProjectFlowStoreState>((set) => ({
  request: null,
  open: (preferredHostId) => {
    set({
      request: {
        id: nextRequestId++,
        ...(preferredHostId ? { preferredHostId } : {}),
      },
    });
  },
  close: () => set({ request: null }),
}));
