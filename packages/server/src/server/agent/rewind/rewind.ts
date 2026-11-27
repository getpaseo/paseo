import {
  RewindNotAppliedError,
  type AgentSession,
  type ConversationRewindResult,
} from "../agent-sdk-types.js";

export type RewindMode = "conversation" | "files" | "both";

/** Thrown before the provider is called, so nothing changed. */
export class RewindCapabilityError extends RewindNotAppliedError {
  constructor(mode: RewindMode) {
    super(`Provider does not support rewinding ${mode}`);
    this.name = "RewindCapabilityError";
  }
}

export async function invokeRewindCapability(
  session: AgentSession,
  input: { messageId: string; mode: RewindMode },
): Promise<ConversationRewindResult | void> {
  switch (input.mode) {
    case "conversation":
      if (!session.capabilities.supportsRewindConversation || !session.revertConversation) {
        throw new RewindCapabilityError(input.mode);
      }
      return session.revertConversation({ messageId: input.messageId });
    case "files":
      if (!session.capabilities.supportsRewindFiles || !session.revertFiles) {
        throw new RewindCapabilityError(input.mode);
      }
      await session.revertFiles({ messageId: input.messageId });
      return;
    case "both":
      if (!session.capabilities.supportsRewindBoth || !session.revertBoth) {
        throw new RewindCapabilityError(input.mode);
      }
      return session.revertBoth({ messageId: input.messageId });
  }
}

/**
 * The provider may or may not have rewound the conversation. The rewind stays open and prompts are
 * refused until reloading the agent lets its history settle the outcome.
 */
export class RewindOutcomeUnknownError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(
      "Paseo could not confirm whether the conversation was rewound. Reload the agent to check, or fork the chat from an earlier message.",
      options,
    );
    this.name = "RewindOutcomeUnknownError";
  }
}
