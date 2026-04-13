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
  pendingByDraftId: Record<string, PendingCreateAttempt>;
  setPending: (pending: Omit<PendingCreateAttempt, "lifecycle">) => void;
  updateAgentId: (input: { draftId: string; agentId: string }) => void;
  markLifecycle: (input: { draftId: string; lifecycle: CreateFlowLifecycleState }) => void;
  rekeyDraft: (input: { fromDraftId: string; toDraftId: string }) => void;
  clear: (input: { draftId: string }) => void;
  clearAll: () => void;
};

export const useCreateFlowStore = create<CreateFlowState>((set) => ({
  pendingByDraftId: {},
  setPending: (pending) =>
    set((state) => ({
      pendingByDraftId: {
        ...state.pendingByDraftId,
        [pending.draftId]: {
          ...pending,
          lifecycle: "active",
        },
      },
    })),
  updateAgentId: ({ draftId, agentId }) =>
    set((state) => {
      const current = state.pendingByDraftId[draftId];
      if (!current || current.agentId === agentId) {
        return state;
      }
      return {
        pendingByDraftId: {
          ...state.pendingByDraftId,
          [draftId]: { ...current, agentId },
        },
      };
    }),
  markLifecycle: ({ draftId, lifecycle }) =>
    set((state) => {
      const current = state.pendingByDraftId[draftId];
      if (!current || current.lifecycle === lifecycle) {
        return state;
      }
      return {
        pendingByDraftId: {
          ...state.pendingByDraftId,
          [draftId]: { ...current, lifecycle },
        },
      };
    }),
  rekeyDraft: ({ fromDraftId, toDraftId }) =>
    set((state) => {
      const current = state.pendingByDraftId[fromDraftId];
      if (!current) {
        return state;
      }
      if (fromDraftId === toDraftId) {
        return state;
      }
      const { [fromDraftId]: _removed, ...rest } = state.pendingByDraftId;
      return {
        pendingByDraftId: {
          ...rest,
          [toDraftId]: { ...current, draftId: toDraftId },
        },
      };
    }),
  clear: ({ draftId }) =>
    set((state) => {
      if (!state.pendingByDraftId[draftId]) {
        return state;
      }
      const { [draftId]: _removed, ...rest } = state.pendingByDraftId;
      return { pendingByDraftId: rest };
    }),
  clearAll: () => set({ pendingByDraftId: {} }),
}));
