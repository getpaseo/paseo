import { useMemo } from "react";
import type { AgentCapabilityFlags } from "@getpaseo/protocol/agent-types";
import type { PendingMessageSubmission } from "@/composer/submission/model";
import type { AgentScreenAgent } from "@/hooks/use-agent-screen-state-machine";
import { type PendingCreateAttempt, useCreateFlowStore } from "@/stores/create-flow-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import {
  resolveTurnPresentation,
  TURN_LIVENESS_IDLE,
  type TurnPresentation,
} from "@/timeline/turn-liveness";
import { createUserMessage, type StreamItem } from "@/types/stream";
import type { WorkspaceDraftTabSetup } from "@/workspace-tabs/model";
import { resolveDraftWorkingDirectory } from "@/composer/draft/workspace-tab-core";

export const DRAFT_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
};

export interface DraftConversation {
  tabId: string;
  workspaceId: string;
  draftId: string;
  setup?: WorkspaceDraftTabSetup;
}

/** The timeline a draft shows while its first prompt creates the agent. */
export interface DraftTimeline {
  agent: AgentScreenAgent;
  streamItems: StreamItem[];
  pendingMessageSubmissions: readonly PendingMessageSubmission[];
  turnPresentation: TurnPresentation;
}

const EMPTY_STREAM_ITEMS: StreamItem[] = [];

/**
 * The sent prompt, pending, with the turn working. The created agent's timeline carries the same
 * row (same client message id), so the handoff only changes who owns it.
 */
export function resolveDraftTimeline(input: {
  pending: PendingCreateAttempt | undefined;
  serverId: string;
  tabId: string;
  cwd: string | null;
}): DraftTimeline | null {
  const { pending, serverId, tabId, cwd } = input;
  if (!pending || pending.serverId !== serverId || pending.lifecycle === "abandoned" || !cwd) {
    return null;
  }
  const hasContent =
    pending.text.length > 0 ||
    (pending.images?.length ?? 0) > 0 ||
    (pending.attachments?.length ?? 0) > 0;
  return {
    agent: { serverId, id: tabId, status: "running", cwd, capabilities: DRAFT_CAPABILITIES },
    streamItems: hasContent
      ? [
          createUserMessage({
            clientMessageId: pending.clientMessageId,
            text: pending.text,
            timestamp: new Date(pending.timestamp),
            images: pending.images,
            attachments: pending.attachments,
          }),
        ]
      : EMPTY_STREAM_ITEMS,
    pendingMessageSubmissions: [{ clientMessageId: pending.clientMessageId }],
    turnPresentation: resolveTurnPresentation(TURN_LIVENESS_IDLE, true),
  };
}

export function useDraftTimeline(input: {
  serverId: string;
  draft: DraftConversation | null;
}): DraftTimeline | null {
  const { serverId, draft } = input;
  const pending = useCreateFlowStore((state) =>
    draft ? state.pendingByDraftId[draft.draftId] : undefined,
  );
  const workspaceDirectory = useWorkspaceFields(
    serverId,
    draft?.workspaceId ?? null,
    (workspace) => workspace.workspaceDirectory,
  );
  const cwd = draft
    ? resolveDraftWorkingDirectory({
        workspaceDirectory: workspaceDirectory || null,
        initialSetup: draft.setup ?? null,
      })
    : null;
  const tabId = draft?.tabId ?? "";
  return useMemo(
    () => resolveDraftTimeline({ pending, serverId, tabId, cwd }),
    [cwd, pending, serverId, tabId],
  );
}
