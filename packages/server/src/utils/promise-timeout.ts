type TimeoutOptions<T> = {
  promise: Promise<T>;
  timeoutMs: number;
  label: string;
};

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T>;
export function withTimeout<T>(options: TimeoutOptions<T>): Promise<T>;
export function withTimeout<T>(
  promiseOrOptions: Promise<T> | TimeoutOptions<T>,
  timeoutMs?: number,
  message?: string,
): Promise<T> {
  const options =
    typeof timeoutMs === "number"
      ? { promise: promiseOrOptions as Promise<T>, timeoutMs, message }
      : resolveTimeoutOptions(promiseOrOptions as TimeoutOptions<T>);

  if (typeof options.timeoutMs !== "number" || !options.message) {
    return Promise.reject(new Error("Timeout duration and message are required"));
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(options.message)), options.timeoutMs);
  });

  return Promise.race([options.promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

function resolveTimeoutOptions<T>(options: TimeoutOptions<T>): {
  promise: Promise<T>;
  timeoutMs: number;
  message: string;
} {
  return {
    promise: options.promise,
    timeoutMs: options.timeoutMs,
    message: `Timed out after ${options.timeoutMs}ms (${options.label})`,
  };
}
