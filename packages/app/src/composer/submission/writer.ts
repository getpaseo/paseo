import type { MessageSubmissionWriter } from "@/composer/actions";
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
