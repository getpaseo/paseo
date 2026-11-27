import { create } from "zustand";

export interface AddProjectFlowRequest {
  id: number;
  preferredHostId?: string;
}

interface AddProjectFlowStoreState {
  request: AddProjectFlowRequest | null;
  /** The parent directory last used to clone or create a project, per host, for this session. */
  lastLocationByHost: Record<string, string>;
  open: (preferredHostId?: string) => void;
  close: () => void;
  rememberLocation: (hostId: string, location: string) => void;
}

let nextRequestId = 1;

export const useAddProjectFlowStore = create<AddProjectFlowStoreState>((set) => ({
  request: null,
  lastLocationByHost: {},
  open: (preferredHostId) => {
    set({
      request: {
        id: nextRequestId++,
        ...(preferredHostId ? { preferredHostId } : {}),
      },
    });
  },
  close: () => set({ request: null }),
  rememberLocation: (hostId, location) =>
    set((state) => ({ lastLocationByHost: { ...state.lastLocationByHost, [hostId]: location } })),
}));
