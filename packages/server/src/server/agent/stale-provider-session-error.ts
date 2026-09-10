/** Thrown when a prompt reaches a plugin session whose connection died with its plugin. */
export class StaleProviderSessionError extends Error {
  constructor(sessionId: string) {
    super(`Provider session ${sessionId} is stale after its plugin reloaded`);
    this.name = "StaleProviderSessionError";
  }
}

export function isStaleProviderSessionError(error: unknown): error is StaleProviderSessionError {
  return error instanceof StaleProviderSessionError;
}
