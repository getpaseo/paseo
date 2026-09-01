import type { MessageSubmissionWriter } from "@/composer/actions";
import {
  acceptMessageSubmission,
  beginMessageSubmission,
  handoffCreatedAgentSubmission,
  getAgentStreamSnapshot,
  hostSupports,
  publishAgentStreamState,
  rejectMessageSubmission,
} from "@/runtime/session-data";
import {
  appendSubmittedUserMessage,
  removeSubmittedUserMessage,
  type UserMessageItem,
} from "@/types/stream";

function appendUntrackedSubmission(serverId: string, agentId: string, message: UserMessageItem) {
  const { tail, head } = getAgentStreamSnapshot(serverId, agentId);
  publishAgentStreamState(serverId, agentId, appendSubmittedUserMessage({ tail, head, message }));
}

function removeUntrackedSubmission(
  serverId: string,
  agentId: string,
  clientMessageId: string,
): void {
  const { tail, head } = getAgentStreamSnapshot(serverId, agentId);
  publishAgentStreamState(
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
  const supportsTrackedMessageSubmissions = hostSupports(serverId, "canonicalSubmittedPrompts");
  if (!supportsTrackedMessageSubmissions) {
    // COMPAT(canonicalSubmittedPrompts): added in v0.2.6; remove the gate after 2027-01-31 once daemon floor >= v0.2.6.
    return createUntrackedMessageSubmissionWriter(serverId);
  }
  return {
    begin: (agentId, message) => beginMessageSubmission(serverId, agentId, message),
    accept: (agentId, clientMessageId) =>
      acceptMessageSubmission(serverId, agentId, clientMessageId),
    reject: (agentId, clientMessageId) =>
      rejectMessageSubmission(serverId, agentId, clientMessageId),
  };
}

export function handoffCreatedAgentMessageSubmission(
  serverId: string,
  agentId: string,
  message: UserMessageItem,
): boolean {
  return handoffCreatedAgentSubmission(serverId, agentId, message);
}
