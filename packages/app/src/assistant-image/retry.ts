export const ASSISTANT_IMAGE_RETRY_DELAYS_MS = [100, 400, 1_200] as const;

export async function runAssistantImageOperationWithRetry<T>(input: {
  operation: () => Promise<T>;
  delaysMs?: readonly number[];
  shouldStop?: () => boolean;
  wait?: (delayMs: number) => Promise<void>;
}): Promise<T> {
  const delays = input.delaysMs ?? ASSISTANT_IMAGE_RETRY_DELAYS_MS;
  const shouldStop = input.shouldStop ?? (() => false);
  const wait =
    input.wait ??
    (async (delayMs: number) => {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    });

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await input.operation();
    } catch (error) {
      const delay = delays[attempt];
      if (delay === undefined || shouldStop()) {
        throw error;
      }
      await wait(delay);
      if (shouldStop()) {
        throw error;
      }
    }
  }
}
