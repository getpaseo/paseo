import { forkSession as claudeForkSession, type Query } from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeRewindSdk {
  forkSession(
    sessionId: string,
    options: { upToMessageId: string },
  ): Promise<{ sessionId: string }>;
}

export const realClaudeRewindSdk: ClaudeRewindSdk = {
  forkSession: claudeForkSession,
};

/**
 * Branch the session at `messageId` and return the new session id, leaving the
 * caller's binding untouched. Rewind is this plus a rebind; a fork keeps both
 * sessions live, so it deliberately does not call back into the agent.
 */
export async function forkClaudeSession(input: {
  sdk: ClaudeRewindSdk;
  sessionId: string | null;
  messageId: string;
  resolveMessageId?: (messageId: string) => string | Promise<string>;
}): Promise<{ providerHandleId: string }> {
  if (!input.sessionId) {
    throw new Error("Claude session is not ready to fork");
  }
  const messageId = (await input.resolveMessageId?.(input.messageId)) ?? input.messageId;
  const fork = await input.sdk.forkSession(input.sessionId, {
    upToMessageId: messageId,
  });
  return { providerHandleId: fork.sessionId };
}

export async function revertClaudeConversation(input: {
  sdk: ClaudeRewindSdk;
  sessionId: string | null;
  messageId: string;
  resolveMessageId?: (messageId: string) => string | Promise<string>;
  setSessionId: (sessionId: string) => void;
}): Promise<void> {
  if (!input.sessionId) {
    throw new Error("Claude session is not ready for rewind");
  }
  const forked = await forkClaudeSession(input);
  input.setSessionId(forked.providerHandleId);
}

export async function revertClaudeFiles(input: {
  query: Query;
  messageId: string;
  resolveMessageId?: (messageId: string) => string | Promise<string>;
}): Promise<void> {
  const messageId = (await input.resolveMessageId?.(input.messageId)) ?? input.messageId;
  const result = await input.query.rewindFiles(messageId, { dryRun: false });
  if (!result.canRewind) {
    throw new Error(result.error ?? `No file checkpoint found for message ${messageId}`);
  }
}

export async function revertClaudeConversationAndFiles(input: {
  sdk: ClaudeRewindSdk;
  query: Query;
  sessionId: string | null;
  messageId: string;
  resolveMessageId?: (messageId: string) => string | Promise<string>;
  setSessionId: (sessionId: string) => void;
}): Promise<void> {
  await revertClaudeFiles({
    query: input.query,
    messageId: input.messageId,
    resolveMessageId: input.resolveMessageId,
  });
  await revertClaudeConversation(input);
}
