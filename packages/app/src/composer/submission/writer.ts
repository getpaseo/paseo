import type { MessageSubmissionWriter, QueueWriter } from "@/composer/actions";
import { useSessionStore } from "@/stores/session-store";
import { useDraftStore, type DraftInput } from "@/stores/draft-store";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import {
  appendSubmittedUserMessage,
  removeSubmittedUserMessage,
  type UserMessageItem,
} from "@/types/stream";

function appendUntrackedSubmission(serverId: string, agentId: string, message: UserMessageItem) {
  const session = useSessionStore.getState().sessions[serverId];
  if (!session) return;
  const tail = session.agentStreamTail.get(agentId) ?? [];
  const head = session.agentStreamHead.get(agentId) ?? [];
  useSessionStore
    .getState()
    .setAgentStreamState(serverId, agentId, appendSubmittedUserMessage({ tail, head, message }));
}

function removeUntrackedSubmission(
  serverId: string,
  agentId: string,
  clientMessageId: string,
): void {
  const session = useSessionStore.getState().sessions[serverId];
  if (!session) return;
  const tail = session.agentStreamTail.get(agentId) ?? [];
  const head = session.agentStreamHead.get(agentId) ?? [];
  useSessionStore
    .getState()
    .setAgentStreamState(
      serverId,
      agentId,
      removeSubmittedUserMessage({ tail, head, clientMessageId }),
    );
}

function createUntrackedMessageSubmissionWriter(serverId: string): MessageSubmissionWriter {
  return {
    begin: (agentId, message) => appendUntrackedSubmission(serverId, agentId, message),
    accept: () => undefined,
    reject: (agentId, clientMessageId) => {
      removeUntrackedSubmission(serverId, agentId, clientMessageId);
      return "rejected";
    },
  };
}

export function createMessageSubmissionWriter(serverId: string): MessageSubmissionWriter {
  const supportsTrackedMessageSubmissions =
    useSessionStore.getState().sessions[serverId]?.serverInfo?.features
      ?.canonicalSubmittedPrompts === true;
  if (!supportsTrackedMessageSubmissions) {
    // COMPAT(canonicalSubmittedPrompts): added in v0.2.6; remove the gate after 2027-01-31 once daemon floor >= v0.2.6.
    return createUntrackedMessageSubmissionWriter(serverId);
  }
  return {
    begin: (agentId, message) =>
      useSessionStore.getState().beginAgentMessageSubmission(serverId, agentId, message),
    accept: (agentId, clientMessageId) =>
      useSessionStore.getState().acceptAgentMessageSubmission(serverId, agentId, clientMessageId),
    reject: (agentId, clientMessageId) =>
      useSessionStore.getState().rejectAgentMessageSubmission(serverId, agentId, clientMessageId),
  };
}

export function createAgentMessageQueueWriter(serverId: string): QueueWriter {
  return {
    read: (agentId) =>
      useSessionStore.getState().sessions[serverId]?.queuedMessages.get(agentId) ?? [],
    write: (update) => useSessionStore.getState().setQueuedMessages(serverId, update),
  };
}

export function handoffCreatedAgentMessageSubmission(
  serverId: string,
  agentId: string,
  message: UserMessageItem,
): boolean {
  return useSessionStore.getState().handoffCreatedAgentUserMessage(serverId, agentId, message);
}

function isEmptyDraft(draft: DraftInput | undefined): boolean {
  return !draft || (!draft.text.trim() && draft.attachments.length === 0);
}

/**
 * Moves the queued follow-ups and the unsent agent draft of one composer identity to the identity
 * that now owns them, such as a recovery draft or the agent it creates. Queued messages keep their
 * IDs and order, after any already queued there; an idle destination agent drains them. The unsent
 * draft moves only into an empty slot, and otherwise stays where it is. Repeating is harmless.
 */
export function transferComposerFollowUps(serverId: string, from: string, to: string): void {
  if (from === to) return;
  const session = useSessionStore.getState().sessions[serverId];
  if (session?.queuedMessages.get(from)?.length) {
    useSessionStore.getState().setQueuedMessages(serverId, (queues) => {
      const moving = queues.get(from);
      if (!moving?.length) return queues;
      const next = new Map(queues);
      next.set(to, [...(queues.get(to) ?? []), ...moving]);
      next.delete(from);
      return next;
    });
    const agent = session.agents.get(to) ?? session.agentDetails.get(to);
    if (agent?.turn.phase === "idle") {
      void import("@/runtime/host-runtime").then(({ getHostRuntimeStore }) =>
        getHostRuntimeStore().drainQueuedAgentMessage(serverId, to),
      );
    }
  }
  const drafts = useDraftStore.getState();
  const source = buildDraftStoreKey({ serverId, agentId: from });
  const destination = buildDraftStoreKey({ serverId, agentId: to });
  const draft = drafts.getDraftInput(source);
  if (!draft || isEmptyDraft(draft) || !isEmptyDraft(drafts.getDraftInput(destination))) return;
  drafts.saveDraftInput({ draftKey: destination, draft });
  drafts.clearDraftInput({ draftKey: source });
}
