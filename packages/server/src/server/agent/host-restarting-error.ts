/**
 * Thrown when a prompt is submitted to a daemon that is draining for a
 * restart. The prompt was NOT admitted to any provider, so the client may
 * safely retry it.
 */
export class HostRestartingError extends Error {
  readonly code = "host_restarting";

  constructor() {
    super("Host is restarting; retry this prompt after the replacement worker is ready.");
    this.name = "HostRestartingError";
  }
}

export function isHostRestartingError(error: unknown): error is HostRestartingError {
  return error instanceof HostRestartingError;
}
