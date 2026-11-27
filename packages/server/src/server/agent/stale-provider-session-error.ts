/**
 * Thrown when a prompt reaches a provider session whose runtime is gone, such as a plugin that
 * reloaded or an agent process that exited. The caller reopens the session from persistence.
 */
export class StaleProviderSessionError extends Error {
  constructor(sessionId: string, cause = "after its plugin reloaded") {
    super(`Provider session ${sessionId} is stale ${cause}`);
    this.name = "StaleProviderSessionError";
  }
}

export function isStaleProviderSessionError(error: unknown): error is StaleProviderSessionError {
  return error instanceof StaleProviderSessionError;
}
