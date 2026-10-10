import type { MessageSubmissionWriter } from "@/composer/actions";
import { getActiveMessageSubmissions } from "@/composer/submission/model";
import { useSessionStore } from "@/stores/session-store";
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

export function handoffCreatedAgentMessageSubmission(
  serverId: string,
  agentId: string,
  message: UserMessageItem,
): boolean {
  return useSessionStore.getState().handoffCreatedAgentUserMessage(serverId, agentId, message);
}

function streamShowsMessage(serverId: string, agentId: string, clientMessageId: string): boolean {
  const session = useSessionStore.getState().sessions[serverId];
  if (!session) return false;
  return [
    ...(session.agentStreamHead.get(agentId) ?? []),
    ...(session.agentStreamTail.get(agentId) ?? []),
  ].some((item) => item.kind === "user_message" && item.clientMessageId === clientMessageId);
}

/**
 * Shows a message the daemon sends for this client, such as the first prompt of an agent a plugin
 * created, until its canonical copy arrives. No client RPC settles it, so it is accepted at once
 * and the canonical echo retires it, the same way it retires a composer send.
 */
export function showDaemonSentAgentMessage(
  serverId: string,
  agentId: string,
  message: UserMessageItem,
): void {
  const clientMessageId = message.clientMessageId;
  const session = useSessionStore.getState().sessions[serverId];
  if (!session || !clientMessageId) return;
  const tracked = session.messageSubmissions
    .get(agentId)
    ?.some((submission) => submission.clientMessageId === clientMessageId);
  // Already painted, or already canonical: a new submission would never be retired.
  if (tracked || streamShowsMessage(serverId, agentId, clientMessageId)) return;
  const writer = createMessageSubmissionWriter(serverId);
  writer.begin(agentId, message);
  writer.accept(agentId, clientMessageId);
}

/**
 * Redraws a message the agent's stream already shows, such as images stored after it was first
 * shown. Its canonical identity is kept; a message no longer in the stream is left out.
 */
export function updateShownAgentMessage(
  serverId: string,
  agentId: string,
  message: UserMessageItem,
): void {
  const clientMessageId = message.clientMessageId;
  if (!clientMessageId || !streamShowsMessage(serverId, agentId, clientMessageId)) return;
  useSessionStore.getState().handoffCreatedAgentUserMessage(serverId, agentId, message);
}

/**
 * Withdraws a message shown with `showDaemonSentAgentMessage` that the daemon will not send, so the
 * agent stops reading as busy. Once its canonical copy has arrived, the message stays.
 */
export function withdrawDaemonSentAgentMessage(
  serverId: string,
  agentId: string,
  clientMessageId: string,
): void {
  const session = useSessionStore.getState().sessions[serverId];
  const pending = getActiveMessageSubmissions(session?.messageSubmissions.get(agentId)).some(
    (submission) => submission.clientMessageId === clientMessageId,
  );
  if (!pending) return;
  useSessionStore.getState().rejectAgentMessageSubmission(serverId, agentId, clientMessageId);
}
