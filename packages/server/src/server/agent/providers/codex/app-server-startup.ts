const CODEX_SQLITE_INITIALIZATION_ERROR = "failed to initialize sqlite state runtime";
const CODEX_APP_SERVER_STARTUP_ATTEMPTS = 3;
const CODEX_APP_SERVER_STARTUP_TIMEOUT_MS = 30_000;

let startupQueue: Promise<void> = Promise.resolve();

interface CodexAppServerStartupOptions<T> {
  start: (attempt: number, signal: AbortSignal) => Promise<T>;
  signal?: AbortSignal;
  timeoutMs?: number;
  onAbort?: () => Promise<void>;
  onRetry?: (error: unknown, nextAttempt: number, maxAttempts: number) => void;
}

function isCodexSqliteInitializationError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(CODEX_SQLITE_INITIALIZATION_ERROR);
}

function raceStartupWithAbort<T>(startup: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const handleAbort = () => reject(signal.reason);
    signal.addEventListener("abort", handleAbort, { once: true });
    void startup.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", handleAbort);
    });
  });
}

function serializeStartup<T>(start: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const run = () => {
    signal?.throwIfAborted();
    return start();
  };
  const next = startupQueue.then(run, run);
  startupQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return signal ? raceStartupWithAbort(next, signal) : next;
}

export function runCodexAppServerStartup<T>(options: CodexAppServerStartupOptions<T>): Promise<T> {
  return serializeStartup(async () => {
    const controller = new AbortController();
    const handleExternalAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", handleExternalAbort, { once: true });
    const timeoutMs = options.timeoutMs ?? CODEX_APP_SERVER_STARTUP_TIMEOUT_MS;
    const timer = setTimeout(() => {
      controller.abort(new Error(`Codex app-server startup timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      options.signal?.throwIfAborted();
      for (let attempt = 1; attempt <= CODEX_APP_SERVER_STARTUP_ATTEMPTS; attempt += 1) {
        controller.signal.throwIfAborted();
        try {
          return await raceStartupWithAbort(
            options.start(attempt, controller.signal),
            controller.signal,
          );
        } catch (error) {
          if (controller.signal.aborted) {
            await options.onAbort?.();
          }
          const canRetry =
            attempt < CODEX_APP_SERVER_STARTUP_ATTEMPTS && isCodexSqliteInitializationError(error);
          if (!canRetry) {
            throw error;
          }
          options.onRetry?.(error, attempt + 1, CODEX_APP_SERVER_STARTUP_ATTEMPTS);
        }
      }
      throw new Error("Codex app-server startup exhausted without a result");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", handleExternalAbort);
    }
  }, options.signal);
}
