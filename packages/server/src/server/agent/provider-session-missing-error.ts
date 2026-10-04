export class ProviderSessionMissingError extends Error {
  constructor(
    readonly sessionId: string,
    cause: Error,
  ) {
    super(cause.message, { cause });
    this.name = "ProviderSessionMissingError";
  }
}
