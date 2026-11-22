import {
  createOpencodeClient,
  type GlobalEvent,
  type OpencodeClient,
} from "@opencode-ai/sdk/v2/client";
import type { Logger } from "pino";

export type OpenCodeEventSourceInput = GlobalEvent | { type: "server-exited"; error: Error };

export interface OpenCodeEventSource {
  ready(): Promise<void>;
  subscribe(listener: (input: OpenCodeEventSourceInput) => void): () => void;
  diagnostics?(): OpenCodeEventStreamDiagnostics;
}

export type OpenCodeEventSourceHandle = OpenCodeEventSource & { close(): Promise<void> };

export interface OpenCodeEventStreamDiagnostics {
  attempt: number;
  phase: "first-record" | "stream";
  elapsedMs: number;
  lastOutcome?: "ended" | "error" | "watchdog";
  lastError?: string;
}

export interface OpenCodeEventConsumerTiming {
  arm(delayMs: number, callback: () => void): () => void;
  wait(delayMs: number, signal: AbortSignal): Promise<void>;
}

export interface OpenCodeEventConsumerOptions {
  serverUrl: string;
  processExit: Promise<Error>;
  listening?: Promise<void>;
  logger: Pick<Logger, "debug" | "warn">;
  createClient?: (baseUrl: string) => OpencodeClient;
  timing?: OpenCodeEventConsumerTiming;
  /** Called once after a sustained failure, before the event source publishes its terminal. */
  onSustainedFailure: (error: Error) => void | Promise<void>;
  now?: () => number;
}

const FIRST_RECORD_WATCHDOG_MS = 5_000;
const WATCHDOG_MS = 30_000;
const MAX_BACKOFF_MS = 5_000;
const FAILURE_WARNING_ATTEMPT = 4;
const FAILURE_BUDGET_MS = 60_000;
const MIN_CONSECUTIVE_FAILURES = 2;
const WARNING_INTERVAL_MS = 60_000;

type OpenCodeEventStreamPhase = "first-record" | "stream";
type OpenCodeConnectionOutcome = "ended" | "error" | "watchdog";

interface OpenCodeConnectionResult {
  delivered: boolean;
  phase: OpenCodeEventStreamPhase;
  outcome: OpenCodeConnectionOutcome;
  error?: unknown;
}

const systemTiming: OpenCodeEventConsumerTiming = {
  arm(delayMs, callback) {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  },
  wait(delayMs, signal) {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const handle = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);
      const onAbort = () => {
        clearTimeout(handle);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  },
};

export class OpenCodeEventConsumer implements OpenCodeEventSource {
  private readonly listeners = new Set<(input: OpenCodeEventSourceInput) => void>();
  private readonly client: OpencodeClient;
  private readonly logger: Pick<Logger, "debug" | "warn">;
  private readonly timing: OpenCodeEventConsumerTiming;
  private readonly onSustainedFailure: (error: Error) => void | Promise<void>;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private connectionAbort = new AbortController();
  private connectionTask: Promise<void>;
  private attempt = 0;
  private phase: OpenCodeEventStreamPhase = "first-record";
  private lastOutcome?: OpenCodeConnectionOutcome;
  private lastError?: string;
  private connected = false;
  private closed = false;
  private failureStartedAt: number | null = null;
  private lastWarningAt: number | null = null;

  constructor(options: OpenCodeEventConsumerOptions) {
    this.client =
      options.createClient?.(options.serverUrl) ??
      createOpencodeClient({ baseUrl: options.serverUrl });
    this.logger = options.logger;
    this.timing = options.timing ?? systemTiming;
    this.onSustainedFailure = options.onSustainedFailure;
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    void this.readyPromise.catch(() => undefined);
    this.connectionTask = this.consume(options.processExit, options.listening);
    void this.connectionTask.catch(() => undefined);
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  subscribe(listener: (input: OpenCodeEventSourceInput) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  diagnostics(): OpenCodeEventStreamDiagnostics {
    return {
      attempt: this.attempt,
      phase: this.phase,
      elapsedMs: Date.now() - this.startedAt,
      ...(this.lastOutcome === undefined ? {} : { lastOutcome: this.lastOutcome }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    const error = new Error("OpenCode event source closed");
    this.rejectReady(error);
    this.connectionAbort.abort(error);
    await this.connectionTask.catch(() => undefined);
  }

  private async consume(processExit: Promise<Error>, listening?: Promise<void>): Promise<void> {
    void processExit.then((error) => this.exit(error));
    if (listening) {
      const signal = this.connectionAbort.signal;
      let stopWaiting!: () => void;
      const stopped = new Promise<void>((resolve) => {
        stopWaiting = resolve;
      });
      signal.addEventListener("abort", stopWaiting, { once: true });
      try {
        await Promise.race([listening, stopped]);
      } catch {
        return;
      } finally {
        signal.removeEventListener("abort", stopWaiting);
      }
    }
    let reconnectAttempt = 0;
    while (!this.closed) {
      this.attempt += 1;
      this.phase = "first-record";
      const result = await this.consumeConnection(this.connectionAbort.signal);
      if (this.closed) return;
      this.lastOutcome = result.outcome;
      this.lastError = result.error === undefined ? undefined : errorMessage(result.error);
      if (result.delivered) {
        this.failureStartedAt = null;
        reconnectAttempt = 0;
      } else {
        // A healthy stream can be idle for a long time, so the last delivered event is not
        // evidence of a sustained failure. Measure the budget from the first failed observation.
        this.failureStartedAt ??= this.now();
        reconnectAttempt += 1;
      }
      const delayMs = Math.min(100 * 2 ** Math.max(0, reconnectAttempt - 1), MAX_BACKOFF_MS);
      this.logConnectionFailure(result, this.attempt, reconnectAttempt, delayMs);
      if (
        !result.delivered &&
        this.failureStartedAt !== null &&
        reconnectAttempt >= MIN_CONSECUTIVE_FAILURES &&
        this.now() - this.failureStartedAt >= FAILURE_BUDGET_MS
      ) {
        const error = new Error(
          `OpenCode server did not deliver an event for ${this.now() - this.failureStartedAt}ms ` +
            `(attempt ${this.attempt}, ${reconnectAttempt} consecutive failures). ` +
            `Last error: ${this.lastError ?? "none"}`,
        );
        try {
          await this.onSustainedFailure(error);
        } catch (callbackError) {
          this.logger.warn(
            { err: callbackError, attempt: this.attempt, consecutiveFailures: reconnectAttempt },
            "OpenCode sustained-failure notification failed",
          );
        }
        this.logger.warn(
          { err: error, attempt: this.attempt, consecutiveFailures: reconnectAttempt },
          "OpenCode event stream unrecoverable; marking server generation failed",
        );
        this.terminate(error);
        return;
      }
      await this.timing.wait(delayMs, this.connectionAbort.signal).catch(() => undefined);
    }
  }

  private async consumeConnection(signal: AbortSignal): Promise<OpenCodeConnectionResult> {
    const requestAbort = new AbortController();
    const attemptToken = { active: true };
    let resolveAbandoned!: (result: OpenCodeConnectionResult) => void;
    const abandoned = new Promise<OpenCodeConnectionResult>((resolve) => {
      resolveAbandoned = resolve;
    });
    const abortRequest = () => {
      attemptToken.active = false;
      resolveAbandoned({ delivered, phase, outcome: "ended" });
      requestAbort.abort(signal.reason);
    };
    signal.addEventListener("abort", abortRequest, { once: true });
    let cancelWatchdog: () => void = () => undefined;
    let delivered = false;
    let phase: OpenCodeEventStreamPhase = "first-record";
    let sseError: unknown;
    const armWatchdog = () => {
      cancelWatchdog();
      cancelWatchdog = this.timing.arm(
        this.connected ? WATCHDOG_MS : FIRST_RECORD_WATCHDOG_MS,
        () => {
          const error = new Error(`OpenCode event stream ${phase} watchdog expired`);
          // Abandon a stalled request even when fetch ignores abort, for example during OpenCode startup.
          attemptToken.active = false;
          resolveAbandoned({ delivered, phase, outcome: "watchdog", error });
          requestAbort.abort(error);
        },
      );
    };
    const consumeStream = async (): Promise<OpenCodeConnectionResult> => {
      try {
        const result = await this.client.global.event({
          signal: requestAbort.signal,
          sseMaxRetryAttempts: 0,
          onSseError: (error) => {
            sseError = error;
          },
        });
        for await (const event of result.stream) {
          // Ignore late records from abandoned requests, for example a delayed server.connected event.
          if (this.closed || !attemptToken.active) {
            return { delivered, phase, outcome: "ended" };
          }
          delivered = true;
          phase = "stream";
          this.phase = phase;
          if (!this.connected && event.payload.type === "server.connected") {
            this.connected = true;
            this.resolveReady();
            armWatchdog();
            continue;
          }
          armWatchdog();
          this.logPluginFailure(event);
          this.publish(event);
        }
        let outcome: OpenCodeConnectionOutcome = "ended";
        if (sseError !== undefined) outcome = "error";
        return {
          delivered,
          phase,
          outcome,
          ...(sseError === undefined ? {} : { error: sseError }),
        };
      } catch (error) {
        return {
          delivered,
          phase,
          outcome: "error",
          error,
        };
      }
    };
    armWatchdog();
    try {
      return await Promise.race([consumeStream(), abandoned]);
    } finally {
      attemptToken.active = false;
      cancelWatchdog();
      signal.removeEventListener("abort", abortRequest);
      requestAbort.abort();
    }
  }

  private logPluginFailure(event: GlobalEvent): void {
    if (event.payload.type !== "session.error") return;
    const error = event.payload.properties.error;
    if (!containsPluginError(error)) return;
    this.logger.warn(
      {
        directory: event.directory,
        sessionId: event.payload.properties.sessionID,
        error,
      },
      "OpenCode plugin failed",
    );
  }

  private logConnectionFailure(
    result: OpenCodeConnectionResult,
    attempt: number,
    consecutiveFailures: number,
    retryDelayMs: number,
  ): void {
    const now = this.now();
    const elapsedMs = now - this.startedAt;
    const details = {
      ...(result.error === undefined ? {} : { err: result.error }),
      phase: result.phase,
      outcome: result.outcome,
      attempt,
      consecutiveFailures,
      elapsedMs,
      retryDelayMs,
      everReady: this.connected,
    };
    const wantsWarning =
      result.outcome === "watchdog" ||
      this.connected ||
      consecutiveFailures >= FAILURE_WARNING_ATTEMPT;
    const warningDue =
      this.lastWarningAt === null ||
      now - this.lastWarningAt >= WARNING_INTERVAL_MS ||
      consecutiveFailures === FAILURE_WARNING_ATTEMPT;
    if (wantsWarning && warningDue) {
      this.lastWarningAt = now;
      this.logger.warn(details, "OpenCode event stream connection failed; retrying");
    } else {
      this.logger.debug(details, "OpenCode event stream connection failed; retrying");
    }
  }

  private terminate(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.connectionAbort.abort(error);
    this.rejectReady(error);
    this.publish({ type: "server-exited", error });
    this.listeners.clear();
  }

  private exit(error: Error): void {
    this.terminate(error);
  }

  private publish(input: OpenCodeEventSourceInput): void {
    for (const listener of this.listeners) {
      try {
        listener(input);
      } catch {
        // A session callback cannot tear down the generation-owned transport.
      }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function containsPluginError(error: unknown): boolean {
  try {
    return JSON.stringify(error).toLowerCase().includes("plugin");
  } catch {
    return false;
  }
}

export type OpenCodeEventConsumerFactory = (
  options: Pick<
    OpenCodeEventConsumerOptions,
    "serverUrl" | "processExit" | "logger" | "listening" | "onSustainedFailure"
  >,
) => OpenCodeEventSourceHandle;
