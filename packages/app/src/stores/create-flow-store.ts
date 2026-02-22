import { create } from "zustand";
import type { UserMessageImageAttachment } from "@/types/stream";

export type CreateFlowLifecycleState = "active" | "abandoned" | "sent";

type PendingCreateAttempt = {
  draftId: string;
  serverId: string;
  agentId: string | null;
  clientMessageId: string;
  text: string;
  timestamp: number;
  lifecycle: CreateFlowLifecycleState;
  images?: UserMessageImageAttachment[];
};

type CreateFlowState = {
  pending: PendingCreateAttempt | null;
  setPending: (
    pending: Omit<PendingCreateAttempt, "lifecycle">
  ) => void;
  updateAgentId: (agentId: string) => void;
  markLifecycle: (lifecycle: CreateFlowLifecycleState) => void;
  rekeyDraft: (input: { fromDraftId: string; toDraftId: string }) => void;
  clear: () => void;
};

export const useCreateFlowStore = create<CreateFlowState>((set) => ({
  pending: null,
  setPending: (pending) =>
    set({
      pending: {
        ...pending,
        lifecycle: "active",
      },
    }),
  updateAgentId: (agentId) =>
    set((state) => {
      if (!state.pending || state.pending.agentId === agentId) {
        return state;
      }
      return {
        pending: {
          ...state.pending,
          agentId,
        },
      };
    }),
  markLifecycle: (lifecycle) =>
    set((state) => {
      if (!state.pending || state.pending.lifecycle === lifecycle) {
        return state;
      }
      return {
        pending: {
          ...state.pending,
          lifecycle,
        },
      };
    }),
  rekeyDraft: ({ fromDraftId, toDraftId }) =>
    set((state) => {
      if (!state.pending || state.pending.draftId !== fromDraftId) {
        return state;
      }
      if (state.pending.draftId === toDraftId) {
        return state;
      }
      return {
        pending: {
          ...state.pending,
          draftId: toDraftId,
        },
      };
    }),
  clear: () => set({ pending: null }),
}));
