import type { ClaudeRewindSdk } from "./rewind.js";

/**
 * Fork a Claude provider session at a message boundary without mutating the
 * source agent's session id. The caller must register a *new* agent with the
 * returned forkedSessionId.
 */
export async function forkClaudeSessionAtMessage(input: {
  sdk: ClaudeRewindSdk;
  sessionId: string;
  upToMessageId: string;
  /** Project cwd so the SDK can locate the session transcript. */
  dir?: string;
}): Promise<{ forkedSessionId: string }> {
  if (!input.sessionId.trim()) {
    throw new Error("Claude session is not ready for native fork");
  }
  if (!input.upToMessageId.trim()) {
    throw new Error("Native fork requires a boundary message id");
  }
  const fork = await input.sdk.forkSession(input.sessionId, {
    upToMessageId: input.upToMessageId,
    ...(input.dir?.trim() ? { dir: input.dir.trim() } : {}),
  });
  const forkedSessionId = fork.sessionId?.trim();
  if (!forkedSessionId) {
    throw new Error("Claude forkSession returned an empty session id");
  }
  return { forkedSessionId };
}
