import { createServer, type ServerResponse } from "node:http";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { afterEach, describe, expect, test } from "vitest";

import {
  OpenCodeEventConsumer,
  type OpenCodeEventConsumerTiming,
  type OpenCodeEventSourceInput,
} from "./event-consumer.js";

describe("OpenCodeEventConsumer", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  test("settles when close wins immediately before an injected backoff wait", async () => {
    const upstream = await createSseUpstream();
    upstream.failNext(1);
    let consumer!: OpenCodeEventConsumer;
    let closePromise: Promise<void> | null = null;
    let observedAlreadyAborted = false;
    const timing: OpenCodeEventConsumerTiming = {
      arm: () => () => undefined,
      get wait() {
        closePromise = consumer.close();
        return async (_delayMs, signal) => {
          observedAlreadyAborted = signal.aborted;
          if (signal.aborted) throw signal.reason;
        };
      },
    };
    consumer = new OpenCodeEventConsumer({
      serverUrl: upstream.url,
      processExit: new Promise<Error>(() => undefined),
      timing,
    });
    cleanups.push(upstream.close);

    await eventually(() => expect(observedAlreadyAborted).toBe(true));
    await expect(closePromise).resolves.toBeUndefined();
  });

  test("becomes ready on the first record and reconnects once after EOF", async () => {
    const upstream = await createSseUpstream();
    const timing = new ControlledTiming();
    const processExit = deferred<Error>();
    const consumer = new OpenCodeEventConsumer({
      serverUrl: upstream.url,
      processExit: processExit.promise,
      timing,
    });
    cleanups.push(async () => {
      await consumer.close();
      await upstream.close();
    });
    const inputs: OpenCodeEventSourceInput[] = [];
    consumer.subscribe((input) => inputs.push(input));

    await upstream.connected(1);
    expect(await promiseState(consumer.ready())).toBe("pending");
    upstream.send(0, connectedRecord("/one"));
    await consumer.ready();
    expect(inputs).toEqual([connectedRecord("/one")]);

    upstream.end(0);
    await timing.waiting();
    expect(timing.waitDelays).toEqual([100]);
    timing.advanceWait();
    await upstream.connected(2);
    upstream.send(1, connectedRecord("/two"));
    await eventually(() => expect(inputs).toHaveLength(3));
    expect(inputs).toEqual([
      connectedRecord("/one"),
      { type: "reconnected" },
      connectedRecord("/two"),
    ]);
    expect(upstream.requests).toHaveLength(2);
    expect(upstream.requests.map((request) => request.url)).toEqual([
      "/global/event",
      "/global/event",
    ]);
  });

  test("reconnects a stalled response without publishing a terminal", async () => {
    const upstream = await createSseUpstream();
    const timing = new ControlledTiming();
    const consumer = new OpenCodeEventConsumer({
      serverUrl: upstream.url,
      processExit: new Promise<Error>(() => undefined),
      timing,
    });
    cleanups.push(async () => {
      await consumer.close();
      await upstream.close();
    });
    const inputs: OpenCodeEventSourceInput[] = [];
    consumer.subscribe((input) => inputs.push(input));
    await upstream.connected(1);
    upstream.send(0, connectedRecord("/one"));
    await consumer.ready();

    timing.expireWatchdog();
    expect(timing.watchdogDelays).toEqual([30_000, 30_000]);
    await timing.waiting();
    timing.advanceWait();
    await upstream.connected(2);
    upstream.send(1, connectedRecord("/two"));
    await eventually(() => expect(inputs).toHaveLength(3));
    expect(inputs[1]).toEqual({ type: "reconnected" });
  });

  test("publishes one terminal and stops reconnecting on process exit", async () => {
    const upstream = await createSseUpstream();
    const timing = new ControlledTiming();
    const processExit = deferred<Error>();
    const consumer = new OpenCodeEventConsumer({
      serverUrl: upstream.url,
      processExit: processExit.promise,
      timing,
    });
    cleanups.push(async () => {
      await consumer.close();
      await upstream.close();
    });
    const inputs: OpenCodeEventSourceInput[] = [];
    consumer.subscribe((input) => inputs.push(input));
    await upstream.connected(1);
    upstream.send(0, connectedRecord("/one"));
    await consumer.ready();

    processExit.resolve(new Error("process exited"));
    await eventually(() => expect(inputs).toHaveLength(2));
    expect(inputs[1]).toMatchObject({ type: "server-exited" });
    expect(upstream.requests).toHaveLength(1);
  });

  test("backs off repeated zero-record EOFs exponentially up to the cap", async () => {
    const upstream = await createSseUpstream();
    const timing = new ControlledTiming();
    const consumer = new OpenCodeEventConsumer({
      serverUrl: upstream.url,
      processExit: new Promise<Error>(() => undefined),
      timing,
    });
    cleanups.push(async () => {
      await consumer.close();
      await upstream.close();
    });

    for (let connection = 0; connection < 8; connection += 1) {
      await upstream.connected(connection + 1);
      upstream.end(connection);
      await timing.waiting();
      timing.advanceWait();
    }

    expect(timing.waitDelays).toEqual([100, 200, 400, 800, 1_600, 3_200, 5_000, 5_000]);
  });

  test("isolates a throwing subscriber from the shared transport", async () => {
    const upstream = await createSseUpstream();
    const timing = new ControlledTiming();
    const consumer = new OpenCodeEventConsumer({
      serverUrl: upstream.url,
      processExit: new Promise<Error>(() => undefined),
      timing,
    });
    cleanups.push(async () => {
      await consumer.close();
      await upstream.close();
    });
    const inputs: OpenCodeEventSourceInput[] = [];
    consumer.subscribe(() => {
      throw new Error("listener failed");
    });
    consumer.subscribe((input) => inputs.push(input));

    await upstream.connected(1);
    upstream.send(0, connectedRecord("/one"));
    await consumer.ready();
    expect(inputs).toEqual([connectedRecord("/one")]);
  });

  test("reconnects after a socket error with a delivered-record backoff reset", async () => {
    const upstream = await createSseUpstream();
    const timing = new ControlledTiming();
    const consumer = new OpenCodeEventConsumer({
      serverUrl: upstream.url,
      processExit: new Promise<Error>(() => undefined),
      timing,
    });
    cleanups.push(async () => {
      await consumer.close();
      await upstream.close();
    });
    await upstream.connected(1);
    upstream.send(0, connectedRecord("/one"));
    await consumer.ready();
    upstream.destroy(0);
    await timing.waiting();
    expect(timing.waitDelays).toEqual([100]);
  });

  test("routes initial HTTP failures through consumer backoff before readiness", async () => {
    const upstream = await createSseUpstream();
    upstream.failNext(2);
    const timing = new ControlledTiming();
    const consumer = new OpenCodeEventConsumer({
      serverUrl: upstream.url,
      processExit: new Promise<Error>(() => undefined),
      timing,
    });
    cleanups.push(async () => {
      await consumer.close();
      await upstream.close();
    });

    await timing.waiting();
    expect(upstream.requests).toHaveLength(1);
    expect(await promiseState(consumer.ready())).toBe("pending");
    timing.advanceWait();
    await timing.waiting();
    expect(upstream.requests).toHaveLength(2);
    timing.advanceWait();
    await upstream.connected(1);
    upstream.send(0, connectedRecord("/ready"));
    await consumer.ready();
    expect(timing.waitDelays).toEqual([100, 200]);
  });

  test("disables SDK SSE retries at the real request seam", async () => {
    const upstream = await createSseUpstream();
    const realClient = createOpencodeClient({ baseUrl: upstream.url });
    let requestOptions: unknown;
    const consumer = new OpenCodeEventConsumer({
      serverUrl: upstream.url,
      processExit: new Promise<Error>(() => undefined),
      createClient: () =>
        ({
          ...realClient,
          global: {
            ...realClient.global,
            event: (options: unknown) => {
              requestOptions = options;
              return realClient.global.event(options as never);
            },
          },
        }) as OpencodeClient,
    });
    cleanups.push(async () => {
      await consumer.close();
      await upstream.close();
    });
    await upstream.connected(1);

    expect(requestOptions).toMatchObject({ sseMaxRetryAttempts: 0 });
  });

  test("rejects readiness and publishes terminal when the process exits before a record", async () => {
    const upstream = await createSseUpstream();
    const processExit = deferred<Error>();
    const consumer = new OpenCodeEventConsumer({
      serverUrl: upstream.url,
      processExit: processExit.promise,
    });
    cleanups.push(async () => {
      await consumer.close();
      await upstream.close();
    });
    const inputs: OpenCodeEventSourceInput[] = [];
    consumer.subscribe((input) => inputs.push(input));
    await upstream.connected(1);

    processExit.resolve(new Error("process exited before ready"));

    await expect(consumer.ready()).rejects.toThrow("process exited before ready");
    expect(inputs).toEqual([expect.objectContaining({ type: "server-exited" })]);
  });

  test("intentional close does not publish a false terminal", async () => {
    const upstream = await createSseUpstream();
    const consumer = new OpenCodeEventConsumer({
      serverUrl: upstream.url,
      processExit: new Promise<Error>(() => undefined),
    });
    cleanups.push(upstream.close);
    const inputs: OpenCodeEventSourceInput[] = [];
    consumer.subscribe((input) => inputs.push(input));
    await upstream.connected(1);
    upstream.send(0, connectedRecord("/one"));
    await consumer.ready();

    await consumer.close();

    expect(inputs).toEqual([connectedRecord("/one")]);
  });
});

class ControlledTiming implements OpenCodeEventConsumerTiming {
  private waits: Array<() => void> = [];
  private watchdog: (() => void) | null = null;
  readonly waitDelays: number[] = [];
  readonly watchdogDelays: number[] = [];
  arm(delayMs: number, callback: () => void): () => void {
    this.watchdogDelays.push(delayMs);
    this.watchdog = callback;
    return () => {
      if (this.watchdog === callback) this.watchdog = null;
    };
  }
  wait(delayMs: number, signal: AbortSignal): Promise<void> {
    this.waitDelays.push(delayMs);
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      this.waits.push(resolve);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }
  async waiting(): Promise<void> {
    await eventually(() => expect(this.waits).toHaveLength(1));
  }
  advanceWait(): void {
    this.waits.shift()?.();
  }
  expireWatchdog(): void {
    const watchdog = this.watchdog;
    this.watchdog = null;
    if (!watchdog) throw new Error("No watchdog is armed");
    watchdog();
  }
}

function connectedRecord(directory: string) {
  return { directory, payload: { type: "server.connected", properties: {} } };
}

async function createSseUpstream() {
  const responses: ServerResponse[] = [];
  const requests: Array<{ url: string | undefined }> = [];
  let failuresRemaining = 0;
  const server = createServer((request, response) => {
    requests.push({ url: request.url });
    if (failuresRemaining > 0) {
      failuresRemaining -= 1;
      response.writeHead(503).end();
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.flushHeaders();
    responses.push(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    connected: async (count: number) => eventually(() => expect(responses).toHaveLength(count)),
    send(index: number, value: unknown) {
      responses[index]?.write(`data: ${JSON.stringify(value)}\n\n`);
    },
    end(index: number) {
      responses[index]?.end();
    },
    destroy(index: number) {
      responses[index]?.destroy(new Error("socket failed"));
    },
    failNext(count: number) {
      failuresRemaining = count;
    },
    close: async () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function promiseState(promise: Promise<unknown>): Promise<"pending" | "settled"> {
  return await Promise.race([
    promise.then(() => "settled" as const),
    new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
  ]);
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  assertion();
}
