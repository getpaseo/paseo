const TERMINAL_ATTACH_RETRYABLE_ERROR_PATTERNS = [
  "terminal not found",
  "timed out",
  "timeout",
  "connection",
  "network",
  "disconnected",
  "stream ended",
] as const;

export function getTerminalResumeOffset(input: {
  terminalId: string;
  resumeOffsetByTerminalId: Map<string, number>;
}): number | undefined {
  const offset = input.resumeOffsetByTerminalId.get(input.terminalId);
  if (typeof offset !== "number" || !Number.isFinite(offset)) {
    return undefined;
  }

  const normalizedOffset = Math.max(0, Math.floor(offset));
  return normalizedOffset;
}

export function updateTerminalResumeOffset(input: {
  terminalId: string;
  offset: number;
  resumeOffsetByTerminalId: Map<string, number>;
}): void {
  if (!Number.isFinite(input.offset)) {
    return;
  }

  const normalizedOffset = Math.max(0, Math.floor(input.offset));
  const previousOffset =
    getTerminalResumeOffset({
      terminalId: input.terminalId,
      resumeOffsetByTerminalId: input.resumeOffsetByTerminalId,
    }) ?? -1;
  if (normalizedOffset <= previousOffset) {
    return;
  }

  input.resumeOffsetByTerminalId.set(input.terminalId, normalizedOffset);
}

export function getTerminalAttachRetryDelayMs(input: { attempt: number }): number {
  const clampedAttempt = Math.max(0, input.attempt);
  const exponentialDelay = 250 * (2 ** clampedAttempt);
  return Math.min(2_000, exponentialDelay);
}

export function isTerminalAttachRetryableError(input: { message: string }): boolean {
  const normalized = input.message.toLowerCase();
  return TERMINAL_ATTACH_RETRYABLE_ERROR_PATTERNS.some((pattern) =>
    normalized.includes(pattern)
  );
}

export async function waitForDuration(input: { durationMs: number }): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, input.durationMs));
  });
}

export async function withPromiseTimeout<T>(input: {
  promise: Promise<T>;
  timeoutMs: number;
  timeoutMessage: string;
}): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(input.timeoutMessage));
    }, Math.max(0, input.timeoutMs));
  });
  try {
    return await Promise.race([input.promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
