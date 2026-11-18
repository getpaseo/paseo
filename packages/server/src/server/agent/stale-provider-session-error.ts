/** Thrown when a prompt reaches a plugin session whose connection died with its plugin. */
export class StaleProviderSessionError extends Error {
  constructor(sessionId: string) {
    super(`Provider session ${sessionId} is stale after its plugin reloaded`);
    this.name = "StaleProviderSessionError";
  }
}

/**
 * Thrown when a prompt reaches a plugin session that has already closed.
 *
 * A session closes when its turn failed, when the provider runtime exited, or when
 * the host ended it. The provider still holds the agent's persistence handle, so the
 * session can be resumed from that handle exactly like a stale one — a closed
 * session is continuable, not a dead end. Distinguishing it from a generic failure
 * is what lets a caller decide to reopen instead of surfacing "Provider session
 * <id> closed" to the user.
 */
export class ClosedProviderSessionError extends Error {
  constructor(sessionId: string, detail?: string) {
    super(detail ?? `Provider session ${sessionId} closed`);
    this.name = "ClosedProviderSessionError";
  }
}

export function isStaleProviderSessionError(error: unknown): error is StaleProviderSessionError {
  return error instanceof StaleProviderSessionError;
}

export function isClosedProviderSessionError(error: unknown): error is ClosedProviderSessionError {
  return error instanceof ClosedProviderSessionError;
}

/**
 * Whether a provider session can be reopened from its persistence handle and the
 * prompt retried: the live session is gone either because its plugin runtime was
 * retired (stale) or because the session itself closed.
 */
export function isReopenableProviderSessionError(
  error: unknown,
): error is StaleProviderSessionError | ClosedProviderSessionError {
  return isStaleProviderSessionError(error) || isClosedProviderSessionError(error);
}
