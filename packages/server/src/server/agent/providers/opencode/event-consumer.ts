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
  logger: Pick<Logger, "debug" | "warn">;
  createClient?: (baseUrl: string) => OpencodeClient;
  timing?: OpenCodeEventConsumerTiming;
}

const WATCHDOG_MS = 30_000;
const MAX_BACKOFF_MS = 5_000;
const FAILURE_WARNING_ATTEMPT = 4;

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
  private readonly startedAt = Date.now();
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

  constructor(options: OpenCodeEventConsumerOptions) {
    this.client =
      options.createClient?.(options.serverUrl) ??
      createOpencodeClient({ baseUrl: options.serverUrl });
    this.logger = options.logger;
    this.timing = options.timing ?? systemTiming;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    void this.readyPromise.catch(() => undefined);
    this.connectionTask = this.consume(options.processExit);
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

  private async consume(processExit: Promise<Error>): Promise<void> {
    void processExit.then((error) => this.exit(error));
    let reconnectAttempt = 0;
    while (!this.closed) {
      this.attempt += 1;
      this.phase = "first-record";
      const result = await this.consumeConnection(this.connectionAbort.signal);
      if (this.closed) return;
      this.lastOutcome = result.outcome;
      this.lastError = result.error === undefined ? undefined : errorMessage(result.error);
      reconnectAttempt = result.delivered ? 0 : reconnectAttempt + 1;
      const delayMs = Math.min(100 * 2 ** Math.max(0, reconnectAttempt - 1), MAX_BACKOFF_MS);
      this.logConnectionFailure(result, this.attempt, reconnectAttempt, delayMs);
      await this.timing.wait(delayMs, this.connectionAbort.signal).catch(() => undefined);
    }
  }

  private async consumeConnection(signal: AbortSignal): Promise<OpenCodeConnectionResult> {
    const requestAbort = new AbortController();
    const abortRequest = () => requestAbort.abort(signal.reason);
    signal.addEventListener("abort", abortRequest, { once: true });
    let cancelWatchdog: () => void = () => undefined;
    let delivered = false;
    let phase: OpenCodeEventStreamPhase = "first-record";
    let watchdogPhase: OpenCodeEventStreamPhase | null = null;
    let sseError: unknown;
    const armWatchdog = () => {
      cancelWatchdog();
      cancelWatchdog = this.timing.arm(WATCHDOG_MS, () => {
        watchdogPhase = phase;
        requestAbort.abort(new Error(`OpenCode event stream ${phase} watchdog expired`));
      });
    };
    try {
      const result = await this.client.global.event({
        signal: requestAbort.signal,
        sseMaxRetryAttempts: 0,
        onSseError: (error) => {
          sseError = error;
        },
      });
      armWatchdog();
      for await (const event of result.stream) {
        if (this.closed) {
          return { delivered, phase, outcome: "ended" };
        }
        armWatchdog();
        delivered = true;
        phase = "stream";
        this.phase = phase;
        if (!this.connected && event.payload.type === "server.connected") {
          this.connected = true;
          this.resolveReady();
          continue;
        }
        this.publish(event);
      }
      let outcome: OpenCodeConnectionOutcome = "ended";
      if (watchdogPhase) outcome = "watchdog";
      else if (sseError !== undefined) outcome = "error";
      return {
        delivered,
        phase: watchdogPhase ?? phase,
        outcome,
        ...(sseError === undefined ? {} : { error: sseError }),
      };
    } catch (error) {
      return {
        delivered,
        phase: watchdogPhase ?? phase,
        outcome: watchdogPhase ? "watchdog" : "error",
        error,
      };
    } finally {
      cancelWatchdog();
      signal.removeEventListener("abort", abortRequest);
      requestAbort.abort();
    }
  }

  private logConnectionFailure(
    result: OpenCodeConnectionResult,
    attempt: number,
    consecutiveFailures: number,
    retryDelayMs: number,
  ): void {
    const elapsedMs = Date.now() - this.startedAt;
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
    const log =
      result.outcome === "watchdog" ||
      this.connected ||
      consecutiveFailures >= FAILURE_WARNING_ATTEMPT
        ? this.logger.warn.bind(this.logger)
        : this.logger.debug.bind(this.logger);
    log(details, "OpenCode event stream connection failed; retrying");
  }

  private exit(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.connectionAbort.abort(error);
    if (!this.connected) this.rejectReady(error);
    this.publish({ type: "server-exited", error });
    this.listeners.clear();
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

export type OpenCodeEventConsumerFactory = (
  options: Pick<OpenCodeEventConsumerOptions, "serverUrl" | "processExit" | "logger">,
) => OpenCodeEventConsumer;
