import { forkSession as claudeForkSession } from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeSessionForkSdk {
  forkSession(sessionId: string, options?: { title?: string }): Promise<{ sessionId: string }>;
}

export const realClaudeSessionForkSdk: ClaudeSessionForkSdk = {
  forkSession: claudeForkSession,
};

/**
 * Branch a Claude session into a new one holding a full copy of the transcript.
 *
 * Deliberately omits `upToMessageId` (rewind's fork slices the transcript; this
 * one copies all of it) and `dir`, so the SDK searches every project directory
 * for the session file — the same resolution rewind relies on.
 */
export async function forkClaudeSession(input: {
  sdk: ClaudeSessionForkSdk;
  sessionId: string | null;
}): Promise<{ sessionId: string }> {
  if (!input.sessionId) {
    throw new Error("Claude session is not ready to fork");
  }
  return input.sdk.forkSession(input.sessionId);
}
