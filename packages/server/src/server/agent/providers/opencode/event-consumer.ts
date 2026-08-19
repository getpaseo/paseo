import {
  createOpencodeClient,
  type GlobalEvent,
  type OpencodeClient,
} from "@opencode-ai/sdk/v2/client";

export type OpenCodeEventSourceInput =
  | GlobalEvent
  | { type: "reconnected" }
  | { type: "server-exited"; error: Error };

export interface OpenCodeEventSource {
  ready(): Promise<void>;
  subscribe(listener: (input: OpenCodeEventSourceInput) => void): () => void;
}

export interface OpenCodeEventConsumerTiming {
  arm(delayMs: number, callback: () => void): () => void;
  wait(delayMs: number, signal: AbortSignal): Promise<void>;
}

export interface OpenCodeEventConsumerOptions {
  serverUrl: string;
  processExit: Promise<Error>;
  createClient?: (baseUrl: string) => OpencodeClient;
  timing?: OpenCodeEventConsumerTiming;
}

const WATCHDOG_MS = 30_000;
const MAX_BACKOFF_MS = 5_000;

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
  private readonly timing: OpenCodeEventConsumerTiming;
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private connectionAbort = new AbortController();
  private connectionTask: Promise<void>;
  private connected = false;
  private closed = false;

  constructor(options: OpenCodeEventConsumerOptions) {
    this.client =
      options.createClient?.(options.serverUrl) ??
      createOpencodeClient({ baseUrl: options.serverUrl });
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
      const delivered = await this.consumeConnection(this.connectionAbort.signal).catch(
        () => false,
      );
      if (this.closed) return;
      reconnectAttempt = delivered ? 0 : reconnectAttempt + 1;
      const delayMs = Math.min(100 * 2 ** Math.max(0, reconnectAttempt - 1), MAX_BACKOFF_MS);
      await this.timing.wait(delayMs, this.connectionAbort.signal).catch(() => undefined);
    }
  }

  private async consumeConnection(signal: AbortSignal): Promise<boolean> {
    const requestAbort = new AbortController();
    const abortRequest = () => requestAbort.abort(signal.reason);
    signal.addEventListener("abort", abortRequest, { once: true });
    let cancelWatchdog: () => void = () => undefined;
    let delivered = false;
    try {
      const result = await this.client.global.event({
        signal: requestAbort.signal,
        sseMaxRetryAttempts: 0,
      });
      const armWatchdog = () => {
        cancelWatchdog();
        cancelWatchdog = this.timing.arm(WATCHDOG_MS, () => requestAbort.abort());
      };
      armWatchdog();
      for await (const event of result.stream) {
        if (this.closed) return delivered;
        armWatchdog();
        if (!delivered) {
          delivered = true;
          if (this.connected) this.publish({ type: "reconnected" });
          this.connected = true;
          this.resolveReady();
        }
        this.publish(event);
      }
      return delivered;
    } finally {
      cancelWatchdog();
      signal.removeEventListener("abort", abortRequest);
      requestAbort.abort();
    }
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

export type OpenCodeEventConsumerFactory = (
  options: Pick<OpenCodeEventConsumerOptions, "serverUrl" | "processExit">,
) => OpenCodeEventConsumer;
