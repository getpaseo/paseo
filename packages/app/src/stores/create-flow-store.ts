import { create } from "zustand";

type PendingCreateAttempt = {
  serverId: string;
  agentId: string | null;
  messageId: string;
  text: string;
  timestamp: number;
};

type CreateFlowState = {
  pending: PendingCreateAttempt | null;
  setPending: (pending: PendingCreateAttempt) => void;
  updateAgentId: (agentId: string) => void;
  clear: () => void;
};

export const useCreateFlowStore = create<CreateFlowState>((set) => ({
  pending: null,
  setPending: (pending) => set({ pending }),
  updateAgentId: (agentId) =>
    set((state) =>
      state.pending ? { pending: { ...state.pending, agentId } } : state
    ),
  clear: () => set({ pending: null }),
}));

