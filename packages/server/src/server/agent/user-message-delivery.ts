import { ActiveTurnBehaviorSchema } from "@getpaseo/protocol/messages";
import type { Logger } from "pino";
import { z } from "zod";
import { ensureAgentLoaded } from "./agent-loading.js";
import type { AgentManager } from "./agent-manager.js";
import { sendPromptToAgent, waitForAgentRunStartWithTimeout } from "./agent-prompt.js";
import type { AgentPromptInput } from "./agent-sdk-types.js";
import type { AgentStorage } from "./agent-storage.js";
import { resolveCreateAgentTitles } from "./create-agent-title.js";

/** A message a person sent to an agent, as it is saved to deliver it again after a restart. */
export const UserMessageSchema = z.object({
  agentId: z.string(),
  /** The typed text, for the provisional title of an untitled agent. */
  text: z.string(),
  prompt: z.custom<AgentPromptInput>((value) => typeof value === "string" || Array.isArray(value)),
  messageId: z.string().optional(),
  activeTurnBehavior: ActiveTurnBehaviorSchema,
  sessionMode: z.string().optional(),
});
export type UserMessage = z.infer<typeof UserMessageSchema>;

export interface UserMessageDeliveryDeps {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
}

/**
 * Loads the agent and starts a turn with the message, then waits until the run has started.
 * A first message also gives an untitled agent its provisional title.
 */
export async function deliverUserMessage(
  deps: UserMessageDeliveryDeps,
  message: UserMessage,
  options: {
    beforeDispatch: () => Promise<void>;
    /** Abandons the wait for the run to start, not the delivery. */
    signal?: AbortSignal;
    setProvisionalTitle: boolean;
  },
): Promise<void> {
  const { agentManager, agentStorage, logger } = deps;
  if (options.setProvisionalTitle) {
    await ensureAgentLoaded(message.agentId, { agentManager, agentStorage, logger });
    const stored = await agentStorage.get(message.agentId);
    if (stored && !stored.title && !stored.lastUserMessageAt) {
      const { provisionalTitle } = resolveCreateAgentTitles({ initialPrompt: message.text });
      if (provisionalTitle) await agentManager.setTitle(message.agentId, provisionalTitle);
    }
  }
  const result = await sendPromptToAgent({
    agentManager,
    agentStorage,
    agentId: message.agentId,
    prompt: message.prompt,
    messageId: message.messageId,
    activeTurnBehavior: message.activeTurnBehavior,
    sessionMode: message.sessionMode,
    // A typed message answers any permission the agent is blocked on.
    clearPendingPermissions: true,
    beforeDispatch: options.beforeDispatch,
    logger,
  });
  if (result.disposition === "turn_started") {
    await waitForAgentRunStartWithTimeout(
      agentManager,
      message.agentId,
      result.started,
      options.signal,
    );
  }
}

/** The agent's error for a message that was accepted but never reached its provider. */
export function describeUndeliveredMessage(text: string, error: unknown): string {
  const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text;
  const reason = error instanceof Error ? error.message : String(error);
  return `Message not delivered: "${preview}". ${reason}`;
}
