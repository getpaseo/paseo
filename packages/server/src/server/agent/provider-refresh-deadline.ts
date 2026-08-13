import type { ProviderRefreshContext } from "./agent-sdk-types.js";

interface RunProviderRefreshOptions<T> {
  label: string;
  timeoutMs: number;
  operation: (context: ProviderRefreshContext) => Promise<T>;
}

export function runProviderRefreshActivity<T>(
  context: ProviderRefreshContext | undefined,
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  return context ? context.runActivity(name, operation) : operation();
}

export async function raceProviderRefreshAbort<T>(
  signal: AbortSignal | undefined,
  operation: Promise<T>,
): Promise<T> {
  if (!signal) return await operation;
  signal.throwIfAborted();
  let handleAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    handleAbort = () => reject(signal.reason);
    signal.addEventListener("abort", handleAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (handleAbort) signal.removeEventListener("abort", handleAbort);
  }
}

export async function runProviderRefreshWithDeadline<T>(
  options: RunProviderRefreshOptions<T>,
): Promise<T> {
  const controller = new AbortController();
  const activityCounts = new Map<string, number>();
  let timeoutError: Error | undefined;

  const context: ProviderRefreshContext = {
    signal: controller.signal,
    async runActivity(name, operation) {
      controller.signal.throwIfAborted();
      activityCounts.set(name, (activityCounts.get(name) ?? 0) + 1);
      try {
        const result = await operation();
        controller.signal.throwIfAborted();
        return result;
      } finally {
        const remaining = (activityCounts.get(name) ?? 1) - 1;
        if (remaining === 0) {
          activityCounts.delete(name);
        } else {
          activityCounts.set(name, remaining);
        }
      }
    },
  };

  const timer = setTimeout(() => {
    const pending = Array.from(activityCounts.keys());
    const suffix = pending.length > 0 ? `; pending: ${pending.join(", ")}` : "";
    timeoutError = new Error(
      `Timed out refreshing ${options.label} after ${options.timeoutMs}ms${suffix}`,
    );
    controller.abort(timeoutError);
  }, options.timeoutMs);

  try {
    const result = await options.operation(context);
    if (timeoutError) throw timeoutError;
    return result;
  } catch (error) {
    throw timeoutError ?? error;
  } finally {
    clearTimeout(timer);
  }
}
