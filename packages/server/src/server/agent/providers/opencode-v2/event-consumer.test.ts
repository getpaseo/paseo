import type { EventSubscribeOutput } from "@opencode-ai/client";
import type { Logger } from "pino";
import { describe, expect, test } from "vitest";

import type { OpenCodeV2ClientLike } from "./client.js";
import { OpenCodeV2EventConsumer, type OpenCodeV2EventConsumerTiming } from "./event-consumer.js";
import type { OpenCodeV2EventSourceInput } from "./server-manager.js";

type StreamBehavior =
  | { kind: "emit"; events: EventSubscribeOutput[] }
  | { kind: "end" }
  | { kind: "never" };

function createScriptedClient(script: StreamBehavior[]): {
  client: OpenCodeV2ClientLike;
  subscriptions: Array<{ signal?: AbortSignal }>;
} {
  const subscriptions: Array<{ signal?: AbortSignal }> = [];
  const client: OpenCodeV2ClientLike = {
    session: {
      create: async () => {
        throw new Error("not used");
      },
      prompt: async () => {
        throw new Error("not used");
      },
      interrupt: async () => {
        throw new Error("not used");
      },
      get: async () => {
        throw new Error("not used");
      },
      remove: async () => {
        throw new Error("not used");
      },
    },
    message: {
      list: async () => {
        throw new Error("not used");
      },
    },
    permission: {
      reply: async () => {
        throw new Error("not used");
      },
    },
    form: {
      reply: async () => {
        throw new Error("not used");
      },
      cancel: async () => {
        throw new Error("not used");
      },
    },
    event: {
      subscribe: (requestOptions?: { signal?: AbortSignal }) => {
        subscriptions.push(requestOptions ?? {});
        const behavior = script.shift() ?? { kind: "never" };
        return streamForBehavior(behavior, requestOptions?.signal);
      },
    },
  };
  return { client, subscriptions };
}

function streamForBehavior(
  behavior: StreamBehavior,
  signal: AbortSignal | undefined,
): AsyncIterable<EventSubscribeOutput> {
  if (behavior.kind === "never") {
    return abortableNever(signal);
  }
  if (behavior.kind === "end") {
    return abortableFrom([], signal);
  }
  return abortableFrom(behavior.events, signal);
}

function abortableNever(signal: AbortSignal | undefined): AsyncIterable<EventSubscribeOutput> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        if (signal?.aborted) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise<IteratorResult<EventSubscribeOutput>>((resolve) => {
          const onAbort = () => resolve({ done: true, value: undefined });
          signal?.addEventListener("abort", onAbort, { once: true });
        });
      },
    }),
  };
}

function abortableFrom(
  events: EventSubscribeOutput[],
  signal: AbortSignal | undefined,
): AsyncIterable<EventSubscribeOutput> {
  return {
    [Symbol.asyncIterator]: () => {
      let index = 0;
      return {
        next: () => {
          if (index < events.length) {
            const value = events[index];
            index += 1;
            return Promise.resolve({ done: false, value });
          }
          if (signal?.aborted) {
            return Promise.resolve({ done: true, value: undefined });
          }
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}

class ControlledTiming implements OpenCodeV2EventConsumerTiming {
  readonly waitDelays: number[] = [];
  private readonly waiters: Array<() => void> = [];
  private readonly armed: Array<() => void> = [];

  arm(_delayMs: number, callback: () => void): () => void {
    this.armed.push(callback);
    return () => {
      const index = this.armed.indexOf(callback);
      if (index >= 0) this.armed.splice(index, 1);
    };
  }

  wait(delayMs: number, signal: AbortSignal): Promise<void> {
    this.waitDelays.push(delayMs);
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.waiters.splice(this.waiters.indexOf(resolve), 1);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(resolve);
    });
  }

  fireWatchdog(): void {
    const callbacks = this.armed.splice(0);
    for (const callback of callbacks) callback();
  }

  advanceWait(): void {
    const resolvers = this.waiters.splice(0);
    for (const resolve of resolvers) resolve();
  }

  async waiting(): Promise<void> {
    while (this.waiters.length === 0) {
      await Promise.resolve();
    }
  }
}

function createRecordingLogger(): Logger {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    debug: () => undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    warn: () => undefined,
  } as unknown as Logger;
}

async function eventually(assertion: () => void | Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  await assertion();
}

function sampleEvent(id: string): EventSubscribeOutput {
  return {
    id,
    created: 1,
    type: "session.text.delta",
    data: {
      sessionID: "session-1",
      assistantMessageID: "assistant-1",
      ordinal: 0,
      delta: "hi",
    },
  };
}

describe("OpenCodeV2EventConsumer", () => {
  test("becomes ready on the first record and publishes the event", async () => {
    const { client, subscriptions } = createScriptedClient([
      { kind: "emit", events: [sampleEvent("e1")] },
    ]);
    const timing = new ControlledTiming();
    const consumer = new OpenCodeV2EventConsumer({
      serverUrl: "http://127.0.0.1:1234",
      authorization: "Basic dGVzdA==",
      processExit: new Promise<Error>(() => undefined),
      logger: createRecordingLogger(),
      timing,
      createClient: () => client,
    });
    const inputs: OpenCodeV2EventSourceInput[] = [];
    consumer.subscribe((input) => inputs.push(input));

    await consumer.ready();
    expect(subscriptions).toHaveLength(1);
    expect(inputs).toEqual([{ type: "event", event: sampleEvent("e1") }]);
    await consumer.close();
  });

  test("publishes reconnected when a stream that delivered events comes back", async () => {
    const { client } = createScriptedClient([
      { kind: "emit", events: [sampleEvent("e1")] },
      { kind: "emit", events: [sampleEvent("e2")] },
    ]);
    const timing = new ControlledTiming();
    const consumer = new OpenCodeV2EventConsumer({
      serverUrl: "http://127.0.0.1:1234",
      authorization: "Basic dGVzdA==",
      processExit: new Promise<Error>(() => undefined),
      logger: createRecordingLogger(),
      timing,
      createClient: () => client,
    });
    const inputs: OpenCodeV2EventSourceInput[] = [];
    consumer.subscribe((input) => inputs.push(input));

    await consumer.ready();
    await timing.waiting();
    expect(timing.waitDelays).toEqual([100]);
    timing.advanceWait();
    await eventually(() => expect(inputs).toHaveLength(3));
    expect(inputs).toEqual([
      { type: "event", event: sampleEvent("e1") },
      { type: "reconnected" },
      { type: "event", event: sampleEvent("e2") },
    ]);
    await consumer.close();
  });

  test("watchdog aborts a stalled stream and reconnects", async () => {
    const { client } = createScriptedClient([
      { kind: "never" },
      { kind: "emit", events: [sampleEvent("e1")] },
    ]);
    const timing = new ControlledTiming();
    const consumer = new OpenCodeV2EventConsumer({
      serverUrl: "http://127.0.0.1:1234",
      authorization: "Basic dGVzdA==",
      processExit: new Promise<Error>(() => undefined),
      logger: createRecordingLogger(),
      timing,
      createClient: () => client,
    });
    const inputs: OpenCodeV2EventSourceInput[] = [];
    consumer.subscribe((input) => inputs.push(input));

    timing.fireWatchdog();
    await timing.waiting();
    timing.advanceWait();
    await eventually(() => expect(inputs).toHaveLength(1));
    expect(inputs).toEqual([{ type: "event", event: sampleEvent("e1") }]);
    await consumer.close();
  });

  test("publishes server-exited when the server process exits", async () => {
    const { client } = createScriptedClient([{ kind: "never" }]);
    const timing = new ControlledTiming();
    let resolveExit!: (error: Error) => void;
    const processExit = new Promise<Error>((resolve) => {
      resolveExit = resolve;
    });
    const consumer = new OpenCodeV2EventConsumer({
      serverUrl: "http://127.0.0.1:1234",
      authorization: "Basic dGVzdA==",
      processExit,
      logger: createRecordingLogger(),
      timing,
      createClient: () => client,
    });
    const inputs: OpenCodeV2EventSourceInput[] = [];
    consumer.subscribe((input) => inputs.push(input));

    resolveExit(new Error("OpenCode 2 server exited with code 1"));
    await eventually(() => expect(inputs).toHaveLength(1));
    expect(inputs[0]).toMatchObject({ type: "server-exited" });
    if (inputs[0].type === "server-exited") {
      expect(inputs[0].error.message).toContain("code 1");
    }
  });

  test("close aborts the connection and settles", async () => {
    const { client } = createScriptedClient([{ kind: "never" }]);
    const timing = new ControlledTiming();
    const consumer = new OpenCodeV2EventConsumer({
      serverUrl: "http://127.0.0.1:1234",
      authorization: "Basic dGVzdA==",
      processExit: new Promise<Error>(() => undefined),
      logger: createRecordingLogger(),
      timing,
      createClient: () => client,
    });
    await expect(consumer.close()).resolves.toBeUndefined();
  });
});
