import type { MessageSubmissionWriter } from "@/composer/actions";
import { useSessionStore } from "@/stores/session-store";

/**
 * Binds the submission lifecycle to a host session. Every path that sends a message to an
 * agent — composer send, queued send-now, automatic queue drain — goes through this so a
 * submitted row and its pending state are always created together.
 */
export function createMessageSubmissionWriter(serverId: string): MessageSubmissionWriter {
  return {
    begin: (agentId, message) =>
      useSessionStore.getState().beginAgentMessageSubmission(serverId, agentId, message),
    accept: (agentId, clientMessageId) =>
      useSessionStore.getState().acceptAgentMessageSubmission(serverId, agentId, clientMessageId),
    reject: (agentId, clientMessageId) =>
      useSessionStore.getState().rejectAgentMessageSubmission(serverId, agentId, clientMessageId),
  };
}
