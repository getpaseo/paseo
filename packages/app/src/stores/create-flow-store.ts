import { create } from "zustand";
import type { UserMessageImageAttachment } from "@/types/stream";
import type { AgentAttachment } from "@getpaseo/protocol/messages";

export type CreateFlowLifecycleState = "active" | "abandoned" | "sent";

export interface PendingCreateAttempt {
  draftId: string;
  serverId: string;
  agentId: string | null;
  clientMessageId: string;
  text: string;
  timestamp: number;
  lifecycle: CreateFlowLifecycleState;
  images?: UserMessageImageAttachment[];
  attachments?: AgentAttachment[];
}

interface CreateFlowState {
  pendingByDraftId: Record<string, PendingCreateAttempt>;
  setPending: (pending: Omit<PendingCreateAttempt, "lifecycle">) => void;
  updateAgentId: (input: { draftId: string; agentId: string }) => void;
  markLifecycle: (input: { draftId: string; lifecycle: CreateFlowLifecycleState }) => void;
  rekeyDraft: (input: { fromDraftId: string; toDraftId: string }) => void;
  clear: (input: { draftId: string }) => void;
  clearByAgent: (input: { serverId: string; agentId: string }) => void;
  clearAll: () => void;
}

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
  clearByAgent: ({ serverId, agentId }) =>
    set((state) => {
      const next = Object.fromEntries(
        Object.entries(state.pendingByDraftId).filter(
          ([, pending]) => pending.serverId !== serverId || pending.agentId !== agentId,
        ),
      );
      if (Object.keys(next).length === Object.keys(state.pendingByDraftId).length) {
        return state;
      }
      return { pendingByDraftId: next };
    }),
  clearAll: () => set({ pendingByDraftId: {} }),
}));
