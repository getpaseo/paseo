import { createAgentMessageDelivery } from "../agent/agent-messages/index.js";
import {
  sendPreparedPromptToAgent,
  waitForAgentRunStartWithTimeout,
} from "../agent/agent-prompt.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { Logger } from "pino";

/** Notification-format tests advance delivery immediately; debounce tests inject their own clock. */
export function createTestAgentMessages(params: {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
}) {
  return createAgentMessageDelivery({
    schedule: (_delay, callback) => {
      const timer = setTimeout(callback, 0);
      return () => clearTimeout(timer);
    },
    dispatch: async (request) => {
      const result = await sendPreparedPromptToAgent({
        ...params,
        agentId: request.recipientId,
        prompt: request.prompt,
        sessionMode: request.sessionMode,
        unarchive: request.unarchive,
        activeTurnBehavior: request.activeTurnBehavior,
        clearPendingPermissions: request.clearPendingPermissions,
        onDispatch: request.onDispatch,
        runOptions: { clientMessageId: request.messageIds[0] },
      });
      if (result.disposition === "turn_started")
        await waitForAgentRunStartWithTimeout(params.agentManager, request.recipientId);
      return result.disposition;
    },
    onError: (error, request) =>
      params.logger.error(
        { err: error, agentId: request.recipientId, messageIds: request.messageIds },
        "Agent message batch dispatch failed",
      ),
  });
}
