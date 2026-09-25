import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "pino";

import { terminateWithTreeKill } from "../../../../utils/tree-kill.js";
import { CodexAppServerExitError } from "./app-server-transport.js";

const DEFAULT_QUEUE_TIMEOUT_MS = 60_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;

interface InitializableAppServerClient {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  dispose(): Promise<void>;
}

interface StartupOptions<TClient extends InitializableAppServerClient> {
  stateDirKey: string;
  spawn: () => ChildProcessWithoutNullStreams | Promise<ChildProcessWithoutNullStreams>;
  createClient: (child: ChildProcessWithoutNullStreams) => TClient;
  initializeParams: unknown;
  logger: Pick<Logger, "warn" | "debug">;
  signal?: AbortSignal;
}

interface CoordinatorOptions {
  queueTimeoutMs?: number;
  attemptTimeoutMs?: number;
  maxAttempts?: number;
}

async function waitForSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function disposeUnownedChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  const result = await terminateWithTreeKill(child, {
    gracefulTimeoutMs: 2_000,
    forceTimeoutMs: 1_000,
  });
  if (result === "kill-timeout") {
    throw new Error("Codex app-server did not report exit after SIGKILL");
  }
}

export class CodexAppServerStartupCoordinator {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly queueTimeoutMs: number;
  private readonly attemptTimeoutMs: number;
  private readonly maxAttempts: number;

  constructor(options: CoordinatorOptions = {}) {
    this.queueTimeoutMs = options.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
    this.attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  async start<TClient extends InitializableAppServerClient>(
    options: StartupOptions<TClient>,
  ): Promise<TClient> {
    options.signal?.throwIfAborted();
    const previous = this.tails.get(options.stateDirKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // An aborted waiter must not let later waiters pass the current owner.
    const tail = previous.then(() => gate);
    this.tails.set(options.stateDirKey, tail);
    void tail.then(
      () => this.tails.get(options.stateDirKey) === tail && this.tails.delete(options.stateDirKey),
    );

    const queueAbort = new AbortController();
    const onAbort = () => queueAbort.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const queueTimer = setTimeout(
      () => queueAbort.abort(new Error("Timed out waiting to start Codex app-server")),
      this.queueTimeoutMs,
    );
    try {
      await waitForSignal(previous, queueAbort.signal);
      clearTimeout(queueTimer);
      options.signal?.throwIfAborted();
      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        try {
          return await this.startAttempt(options);
        } catch (error) {
          const isRetryableStartupFailure =
            error instanceof CodexAppServerExitError &&
            error.reason === "sqlite_state_initialization";
          if (
            options.signal?.aborted ||
            attempt === this.maxAttempts ||
            !isRetryableStartupFailure
          ) {
            throw error;
          }
          options.logger.warn(
            { err: error, attempt, maxAttempts: this.maxAttempts },
            "Codex app-server SQLite startup failed; retrying with a fresh process",
          );
        }
      }
      throw new Error("Codex app-server startup attempts exhausted");
    } finally {
      clearTimeout(queueTimer);
      options.signal?.removeEventListener("abort", onAbort);
      release();
    }
  }

  private async startAttempt<TClient extends InitializableAppServerClient>(
    options: StartupOptions<TClient>,
  ): Promise<TClient> {
    const attemptAbort = new AbortController();
    const onAbort = () => attemptAbort.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const attemptTimer = setTimeout(
      () => attemptAbort.abort(new Error("Timed out initializing Codex app-server")),
      this.attemptTimeoutMs,
    );
    let child: ChildProcessWithoutNullStreams | undefined;
    let client: TClient | undefined;
    try {
      attemptAbort.signal.throwIfAborted();
      // Production hands in a synchronous spawn closure. Resolve the binary
      // before entering the lane, then create the child while holding it.
      const spawnPromise = Promise.resolve(options.spawn());
      try {
        child = await waitForSignal(spawnPromise, attemptAbort.signal);
      } catch (error) {
        if (attemptAbort.signal.aborted) {
          // A future asynchronous spawner may finish after cancellation.
          void spawnPromise
            .then((lateChild) => disposeUnownedChild(lateChild))
            .catch((cleanupError) =>
              options.logger.warn({ err: cleanupError }, "Failed to clean up late Codex spawn"),
            );
        }
        throw error;
      }
      attemptAbort.signal.throwIfAborted();
      client = options.createClient(child);
      await waitForSignal(
        client.request("initialize", options.initializeParams, this.attemptTimeoutMs),
        attemptAbort.signal,
      );
      attemptAbort.signal.throwIfAborted();
      client.notify("initialized", {});
      return client;
    } catch (error) {
      try {
        if (client) {
          await client.dispose();
        } else if (child) {
          await disposeUnownedChild(child);
        }
      } catch (cleanupError) {
        options.logger.warn(
          { err: cleanupError, startupError: error },
          "Failed to clean up Codex app-server after startup failure",
        );
        throw new Error("Codex app-server startup cleanup failed", { cause: cleanupError });
      }
      throw error;
    } finally {
      clearTimeout(attemptTimer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
}

export const codexAppServerStartup = new CodexAppServerStartupCoordinator();
