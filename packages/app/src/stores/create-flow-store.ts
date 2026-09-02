import { create } from "zustand";
import type { UserMessageImageAttachment } from "@/types/stream";
import type { AgentAttachment } from "@getpaseo/protocol/messages";

export type CreateFlowLifecycleState = "active" | "abandoned" | "sent";

export interface PendingCreateAttempt {
  draftId: string;
  serverId: string;
  workspaceId?: string;
  agentId: string | null;
  clientMessageId: string;
  text: string;
  timestamp: number;
  lifecycle: CreateFlowLifecycleState;
  images?: UserMessageImageAttachment[];
  attachments?: AgentAttachment[];
}

export function isActiveCreateFlowForDraft(input: {
  pending: PendingCreateAttempt | null | undefined;
  serverId: string;
  draftId: string | null | undefined;
}): boolean {
  const draftId = input.draftId?.trim();
  return Boolean(
    draftId &&
    input.pending?.draftId === draftId &&
    input.pending.serverId === input.serverId &&
    input.pending.lifecycle === "active",
  );
}

interface CreateFlowState {
  pendingByDraftId: Record<string, PendingCreateAttempt>;
  /** Create attempts that are in flight, keyed by `${serverId}:${workspaceId}`. */
  createInFlightByWorkspace: Record<string, string>;
  setPending: (pending: Omit<PendingCreateAttempt, "lifecycle">) => void;
  updateAgentId: (input: { draftId: string; agentId: string }) => void;
  markLifecycle: (input: { draftId: string; lifecycle: CreateFlowLifecycleState }) => void;
  rekeyDraft: (input: { fromDraftId: string; toDraftId: string }) => void;
  clear: (input: { draftId: string }) => void;
  clearByAgent: (input: { serverId: string; agentId: string }) => void;
  clearAll: () => void;
  /** Synchronously claim the create slot for a workspace; returns false when one is already in flight. */
  tryBeginCreate: (input: {
    serverId: string;
    workspaceId: string | null | undefined;
    clientMessageId: string;
  }) => boolean;
  endCreate: (input: { serverId: string; workspaceId: string | null | undefined }) => void;
}

function buildCreateInFlightKey(serverId: string, workspaceId: string): string {
  return `${serverId}:${workspaceId}`;
}

export const useCreateFlowStore = create<CreateFlowState>((set, get) => ({
  pendingByDraftId: {},
  createInFlightByWorkspace: {},
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
          ([, pending]) =>
            pending.lifecycle !== "sent" ||
            pending.serverId !== serverId ||
            pending.agentId !== agentId,
        ),
      );
      if (Object.keys(next).length === Object.keys(state.pendingByDraftId).length) {
        return state;
      }
      return { pendingByDraftId: next };
    }),
  clearAll: () => set({ pendingByDraftId: {}, createInFlightByWorkspace: {} }),
  tryBeginCreate: ({ serverId, workspaceId, clientMessageId }) => {
    if (!workspaceId) {
      return true;
    }
    const key = buildCreateInFlightKey(serverId, workspaceId);
    if (get().createInFlightByWorkspace[key]) {
      return false;
    }
    set({
      createInFlightByWorkspace: {
        ...get().createInFlightByWorkspace,
        [key]: clientMessageId,
      },
    });
    return true;
  },
  endCreate: ({ serverId, workspaceId }) => {
    if (!workspaceId) {
      return;
    }
    const key = buildCreateInFlightKey(serverId, workspaceId);
    set((state) => {
      if (!state.createInFlightByWorkspace[key]) {
        return state;
      }
      const { [key]: _removed, ...rest } = state.createInFlightByWorkspace;
      return { createInFlightByWorkspace: rest };
    });
  },
}));
