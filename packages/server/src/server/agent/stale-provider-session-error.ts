/** Thrown when a prompt reaches a plugin session whose connection died with its plugin. */
export class StaleProviderSessionError extends Error {
  constructor(sessionId: string) {
    super(`Provider session ${sessionId} is stale after its plugin reloaded`);
    this.name = "StaleProviderSessionError";
  }
}

export function isStaleProviderSessionError(error: unknown): boolean {
  if (error instanceof StaleProviderSessionError) return true;
  if (!(error instanceof Error)) return false;
  return (
    error.message === "Provider connection is closed" ||
    error.message === "Provider connection closed" ||
    error.message === "Provider runtime is closed" ||
    error.message === "Provider closed"
  );
}
