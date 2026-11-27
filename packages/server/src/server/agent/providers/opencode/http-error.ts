export class OpenCodeHttpError extends Error {
  readonly name = "OpenCodeHttpError";

  constructor(
    readonly operation: string,
    readonly status: number | undefined,
    readonly html: boolean,
  ) {
    const statusLabel = status === undefined ? "" : ` (HTTP ${status})`;
    super(
      html
        ? `OpenCode ${operation} returned HTML instead of JSON; incompatible OpenCode API${statusLabel}`
        : `OpenCode ${operation} failed${statusLabel}`,
    );
  }
}

/** True when OpenCode answered 404, directly or as the cause of the client's transport error. */
export function isOpenCodeNotFound(error: unknown): boolean {
  const failure = error instanceof OpenCodeHttpError ? error : (error as Error | null)?.cause;
  return failure instanceof OpenCodeHttpError && failure.status === 404;
}
