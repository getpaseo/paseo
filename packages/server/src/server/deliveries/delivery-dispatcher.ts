import type pino from "pino";
import type { DeliveryPayload } from "@getpaseo/protocol/deliveries";
import type { AgentManager } from "../agent/agent-manager.js";
import { sendPromptToAgent, waitForAgentRunStartWithTimeout } from "../agent/agent-prompt.js";
import type { AgentStorage } from "../agent/agent-storage.js";

export interface DeliveryAgentDispatchInput {
  targetAgentId: string;
  messageId: string;
  payload: DeliveryPayload;
}

export type DeliveryAgentDispatchResult =
  | { outcome: "accepted" }
  | { outcome: "failed" | "ambiguous"; error: string };

export type DeliveryAgentDispatcher = (
  input: DeliveryAgentDispatchInput,
) => Promise<DeliveryAgentDispatchResult>;

function serializeDeliveryPrompt(payload: DeliveryPayload): string {
  // Preserve the JSON envelope for non-string events so the agent receives the
  // exact value that was durably recorded. A plain string remains a useful
  // prompt instead of gaining an extra pair of JSON quotes.
  return typeof payload === "string" ? payload : JSON.stringify(payload);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDefinitelyFailedBeforeDispatch(error: unknown): boolean {
  const message = describeError(error).toLowerCase();
  return (
    message.includes("agent not found") ||
    message.includes("agent is archived") ||
    message.includes("unavailable provider") ||
    message.includes("references unavailable provider")
  );
}

/**
 * The only native delivery implementation. It intentionally delegates to the
 * same prompt orchestration used by the normal agent message RPC, including
 * provider loading, active-turn behavior, message identity, and run-start
 * acknowledgement.
 */
export function createNativeDeliveryDispatcher(input: {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: pino.Logger;
}): DeliveryAgentDispatcher {
  return async ({ targetAgentId, messageId, payload }) => {
    try {
      const result = await sendPromptToAgent({
        agentManager: input.agentManager,
        agentStorage: input.agentStorage,
        agentId: targetAgentId,
        prompt: serializeDeliveryPrompt(payload),
        messageId,
        // Delivery is a user-visible prompt and follows the native send path's
        // normal interrupt behavior. The target ID is never inferred from the
        // payload or the sender principal.
        activeTurnBehavior: "interrupt",
        clearPendingPermissions: true,
        logger: input.logger,
      });
      if (result.disposition === "turn_started") {
        try {
          await waitForAgentRunStartWithTimeout(input.agentManager, targetAgentId);
        } catch (error) {
          // The provider may still start after this wait expires. Retrying would
          // therefore violate at-most-once delivery.
          return { outcome: "ambiguous", error: describeError(error) };
        }
      }
      return { outcome: "accepted" };
    } catch (error) {
      const message = describeError(error);
      return {
        outcome: isDefinitelyFailedBeforeDispatch(error) ? "failed" : "ambiguous",
        error: message,
      };
    }
  };
}

export function serializeDeliveryPromptForTest(payload: DeliveryPayload): string {
  return serializeDeliveryPrompt(payload);
}
