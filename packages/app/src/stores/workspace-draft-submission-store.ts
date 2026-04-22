import { create } from "zustand";
import type { ComposerAttachment } from "@/attachments/types";
import type { AgentProvider } from "@server/server/agent/agent-sdk-types";

export interface PendingWorkspaceDraftSubmission {
  serverId: string;
  workspaceId: string;
  draftId: string;
  text: string;
  attachments: ComposerAttachment[];
  cwd: string;
  provider: AgentProvider;
  modeId?: string;
  model?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  allowEmptyText?: boolean;
}

type WorkspaceDraftSubmissionState = {
  pendingByDraftId: Record<string, PendingWorkspaceDraftSubmission>;
  setPending: (submission: PendingWorkspaceDraftSubmission) => void;
  consumePending: (input: {
    serverId: string;
    workspaceId: string;
    draftId: string;
  }) => PendingWorkspaceDraftSubmission | null;
};

function matchesPendingSubmission(
  pending: PendingWorkspaceDraftSubmission | null | undefined,
  input: { serverId: string; workspaceId: string; draftId: string },
): pending is PendingWorkspaceDraftSubmission {
  return (
    pending?.serverId === input.serverId &&
    pending.workspaceId === input.workspaceId &&
    pending.draftId === input.draftId
  );
}

export const useWorkspaceDraftSubmissionStore = create<WorkspaceDraftSubmissionState>(
  (set, get) => ({
    pendingByDraftId: {},
    setPending: (submission) =>
      set((state) => ({
        pendingByDraftId: {
          ...state.pendingByDraftId,
          [submission.draftId]: submission,
        },
      })),
    consumePending: (input) => {
      const pending = get().pendingByDraftId[input.draftId];
      if (!matchesPendingSubmission(pending, input)) {
        return null;
      }
      set((state) => {
        if (!matchesPendingSubmission(state.pendingByDraftId[input.draftId], input)) {
          return state;
        }
        const { [input.draftId]: _removed, ...rest } = state.pendingByDraftId;
        return { pendingByDraftId: rest };
      });
      return pending;
    },
  }),
);
