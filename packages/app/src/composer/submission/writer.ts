import type { MessageSubmissionWriter } from "@/composer/actions";
import { useSessionStore } from "@/stores/session-store";
import type { TimelineReplica } from "@/timeline/replica";

export function createMessageSubmissionWriter(
  serverId: string,
  replica: TimelineReplica,
): MessageSubmissionWriter {
  // COMPAT(canonicalSubmittedPrompts): added in v0.2.6; remove the gate after 2027-01-31 once daemon floor >= v0.2.6.
  const tracked =
    useSessionStore.getState().sessions[serverId]?.serverInfo?.features
      ?.canonicalSubmittedPrompts === true;
  return {
    begin: (agentId, message) => replica.beginSubmission(agentId, message, tracked),
    accept: (agentId, clientMessageId) => replica.acceptSubmission(agentId, clientMessageId),
    reject: (agentId, clientMessageId) =>
      replica.rejectSubmission(agentId, clientMessageId, tracked),
  };
}
