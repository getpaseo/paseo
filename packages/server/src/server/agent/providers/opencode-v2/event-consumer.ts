import type { Logger } from "pino";

import {
  createOpenCodeV2Client,
  type OpenCodeV2ClientFactory,
  type OpenCodeV2ClientLike,
} from "./client.js";
import type {
  OpenCodeV2EventSource,
  OpenCodeV2EventSourceFactoryOptions,
  OpenCodeV2EventSourceInput,
} from "./server-manager.js";

export interface OpenCodeV2EventConsumerTiming {
  arm(delayMs: number, callback: () => void): () => void;
  wait(delayMs: number, signal: AbortSignal): Promise<void>;
}

export interface OpenCodeV2EventConsumerOptions extends OpenCodeV2EventSourceFactoryOptions {
  createClient?: OpenCodeV2ClientFactory;
  timing?: OpenCodeV2EventConsumerTiming;
}

const WATCHDOG_MS = 30_000;
const MAX_BACKOFF_MS = 5_000;
const FAILURE_WARNING_ATTEMPT = 4;

type OpenCodeV2EventStreamPhase = "first-record" | "stream";
type OpenCodeV2ConnectionOutcome = "ended" | "error" | "watchdog";

interface OpenCodeV2ConnectionResult {
  delivered: boolean;
  phase: OpenCodeV2EventStreamPhase;
  outcome: OpenCodeV2ConnectionOutcome;
  error?: unknown;
}

const systemTiming: OpenCodeV2EventConsumerTiming = {
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

/**
 * SSE-backed event source for the opencode2 server. Subscribes to
 * `client.event.subscribe()` and publishes each v2 event envelope as
 * `{ type: "event", event }`. A watchdog aborts a stalled stream and the
 * consumer reconnects with exponential backoff, publishing `reconnected`
 * once a stream that previously delivered events comes back. When the server
 * process exits, `server-exited` is published and the source closes.
 */
export class OpenCodeV2EventConsumer implements OpenCodeV2EventSource {
  private readonly listeners = new Set<(input: OpenCodeV2EventSourceInput) => void>();
  private readonly client: OpenCodeV2ClientLike;
  private readonly logger: Pick<Logger, "debug" | "warn">;
  private readonly timing: OpenCodeV2EventConsumerTiming;
  private readonly startedAt = Date.now();
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private connectionAbort = new AbortController();
  private connectionTask: Promise<void>;
  private attempt = 0;
  private phase: OpenCodeV2EventStreamPhase = "first-record";
  private lastOutcome?: OpenCodeV2ConnectionOutcome;
  private lastError?: string;
  private connected = false;
  private closed = false;

  constructor(options: OpenCodeV2EventConsumerOptions) {
    const createClient = options.createClient ?? createOpenCodeV2Client;
    this.client = createClient({
      baseUrl: options.serverUrl,
      authorization: options.authorization,
    });
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

  subscribe(listener: (input: OpenCodeV2EventSourceInput) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  diagnostics(): OpenCodeV2EventStreamDiagnostics {
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
    const error = new Error("OpenCode 2 event source closed");
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

  private async consumeConnection(signal: AbortSignal): Promise<OpenCodeV2ConnectionResult> {
    const requestAbort = new AbortController();
    const abortRequest = () => requestAbort.abort(signal.reason);
    signal.addEventListener("abort", abortRequest, { once: true });
    let cancelWatchdog: () => void = () => undefined;
    let delivered = false;
    let phase: OpenCodeV2EventStreamPhase = "first-record";
    let watchdogPhase: OpenCodeV2EventStreamPhase | null = null;
    const armWatchdog = () => {
      cancelWatchdog();
      cancelWatchdog = this.timing.arm(WATCHDOG_MS, () => {
        watchdogPhase = phase;
        requestAbort.abort(new Error(`OpenCode 2 event stream ${phase} watchdog expired`));
      });
    };
    try {
      const stream = this.client.event.subscribe({ signal: requestAbort.signal });
      armWatchdog();
      for await (const event of stream) {
        if (this.closed) {
          return { delivered, phase, outcome: "ended" };
        }
        armWatchdog();
        if (!delivered) {
          delivered = true;
          if (this.connected) this.publish({ type: "reconnected" });
          this.connected = true;
          this.resolveReady();
        }
        phase = "stream";
        this.phase = phase;
        this.publish({ type: "event", event });
      }
      let outcome: OpenCodeV2ConnectionOutcome = watchdogPhase ? "watchdog" : "ended";
      return {
        delivered,
        phase: watchdogPhase ?? phase,
        outcome,
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
    result: OpenCodeV2ConnectionResult,
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
    log(details, "OpenCode 2 event stream connection failed; retrying");
  }

  private exit(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.connectionAbort.abort(error);
    if (!this.connected) this.rejectReady(error);
    this.publish({ type: "server-exited", error });
    this.listeners.clear();
  }

  private publish(input: OpenCodeV2EventSourceInput): void {
    for (const listener of this.listeners) {
      try {
        listener(input);
      } catch {
        // A session callback cannot tear down the generation-owned transport.
      }
    }
  }
}

export interface OpenCodeV2EventStreamDiagnostics {
  attempt: number;
  phase: "first-record" | "stream";
  elapsedMs: number;
  lastOutcome?: "ended" | "error" | "watchdog";
  lastError?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
