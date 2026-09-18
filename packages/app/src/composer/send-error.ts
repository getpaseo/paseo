export class ManualRetryRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManualRetryRequiredError";
  }
}

export function requiresManualRetry(error: unknown): boolean {
  return error instanceof ManualRetryRequiredError;
}
