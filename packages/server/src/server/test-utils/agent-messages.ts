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
  schedule?: (delayMs: number, callback: () => void) => () => void;
}) {
  return createAgentMessageDelivery({
    tryRunOutOfBand: (request, onAccepted) =>
      params.agentManager.tryRunOutOfBand(
        request.recipientId,
        request.prompt,
        { clientMessageId: request.messageIds[0] },
        onAccepted,
      ),
    isRunning: (agentId) => params.agentManager.hasInFlightRun(agentId),
    hasPendingPermission: (agentId) => params.agentManager.hasPendingPermissions(agentId),
    subscribe: (notify) =>
      params.agentManager.subscribe(
        (event) => {
          if (event.type === "agent_state") notify(event.agent.id);
        },
        { replayState: false },
      ),
    onStop: (notify) => params.agentManager.onStop(notify),
    schedule:
      params.schedule ??
      ((_delay, callback) => {
        const timer = setTimeout(callback, 0);
        return () => clearTimeout(timer);
      }),
    dispatch: async (request) => {
      const result = await sendPreparedPromptToAgent({
        ...params,
        agentId: request.recipientId,
        prompt: request.prompt,
        sessionMode: request.sessionMode,
        unarchive: request.unarchive,
        activeTurnBehavior: request.activeTurnBehavior,
        idleOnly: request.idleOnly,
        admit: request.admit,
        clearPendingPermissions: request.clearPendingPermissions,
        runOptions: { clientMessageId: request.messageIds[0] },
      });
      if (result.disposition === "turn_started")
        await waitForAgentRunStartWithTimeout(
          params.agentManager,
          request.recipientId,
          result.started,
        );
      return result.disposition;
    },
    awaitStart: (agentId, started) =>
      waitForAgentRunStartWithTimeout(params.agentManager, agentId, started),
    onError: (error, request) =>
      params.logger.error(
        { err: error, agentId: request.recipientId, messageIds: request.messageIds },
        "Agent message batch dispatch failed",
      ),
  });
}
