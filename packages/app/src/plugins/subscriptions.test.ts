import { defineSubscription } from "@getpaseo/plugin";
import type { PluginSubscriptionClosed } from "@getpaseo/plugin/client";
import { subscribePluginRpc } from "@getpaseo/plugin/client/host";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { SubscriptionObserver } from "@getpaseo/client";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { expect, it } from "vitest";
import { z } from "zod";
import { createPluginSubscribe } from "./subscriptions";

const changes = defineSubscription({
  name: "diff.watch",
  input: z.object({ ref: z.string() }),
  event: z.union([z.instanceof(Uint8Array), z.object({ path: z.string() })]),
});

type Observed = Parameters<DaemonClient["observePluginRpc"]>;

/** One host-side subscription as the daemon client exposes it, driven by the test. */
class HostSubscription {
  readonly released: Promise<void>;
  isReleased = false;
  private observer: SubscriptionObserver<never> | null = null;
  private accept!: () => void;
  private refuse!: (error: Error) => void;
  private markReleased!: () => void;
  readonly ready = new Promise<never>((resolve, reject) => {
    this.accept = () => resolve({ requestId: "r", subscriptionId: "s" } as never);
    this.refuse = reject;
  });

  constructor(
    readonly method: string,
    readonly input: unknown,
    readonly signal: AbortSignal | undefined,
  ) {
    void this.ready.catch(() => undefined);
    this.released = new Promise((resolve) => {
      this.markReleased = resolve;
    });
    signal?.addEventListener("abort", () => void this.release(), { once: true });
  }

  handle() {
    return {
      subscriptionId: "s",
      ready: this.ready,
      subscribe: (observer: SubscriptionObserver<never>) => {
        this.observer = observer;
        return () => undefined;
      },
      release: () => this.release(),
    };
  }

  acknowledge() {
    this.accept();
  }

  refuseWith(error: Error) {
    this.refuse(error);
    this.observer?.error?.(error);
  }

  event(event: unknown) {
    this.observer?.update({
      type: "plugin.rpc.event",
      payload: { subscriptionId: "s", event },
    } as SessionOutboundMessage);
  }

  bytes(payload: Uint8Array) {
    this.observer?.binary?.(payload);
  }

  closed(error?: string) {
    this.observer?.update({
      type: "plugin.rpc.closed",
      payload: { subscriptionId: "s", ...(error ? { error } : {}) },
    } as SessionOutboundMessage);
  }

  async release() {
    this.isReleased = true;
    this.markReleased();
  }
}

/** An installation's subscribe on a host the test drives, and what one subscriber observed. */
function installation() {
  const subscriptions: HostSubscription[] = [];
  const client = {
    observePluginRpc: (...[pluginId, method, input, options]: Observed) => {
      expect(pluginId).toBe("diffs");
      const subscription = new HostSubscription(method, input, options?.signal);
      subscriptions.push(subscription);
      return subscription.handle() as unknown as ReturnType<DaemonClient["observePluginRpc"]>;
    },
  };
  const lifetime = new AbortController();
  const subscribe = createPluginSubscribe({ client, pluginId: "diffs", lifetime: lifetime.signal });
  function open(ref: string, signal?: AbortSignal) {
    const received: string[] = [];
    const closed: PluginSubscriptionClosed[] = [];
    const handle = subscribePluginRpc(
      changes,
      subscribe,
      { ref },
      (event) =>
        received.push(event instanceof Uint8Array ? `bytes:${[...event]}` : `path:${event.path}`),
      { signal, onClosed: (result) => closed.push(result) },
    );
    return { handle, received, closed, host: subscriptions[subscriptions.length - 1]! };
  }
  return { open, lifetime };
}

it("delivers JSON and byte events in order and releases the host subscription", async () => {
  const { open } = installation();
  const { handle, received, closed, host } = open("main");
  expect(host.method).toBe("diff.watch");
  expect(host.input).toEqual({ ref: "main" });
  host.acknowledge();
  await handle.ready;

  host.event({ path: "a.ts" });
  host.bytes(new Uint8Array([1, 2]));
  expect(received).toEqual(["path:a.ts", "bytes:1,2"]);

  handle();
  await host.released;
  expect(closed).toEqual([]);
});

it("reports a refusal, a failure after going live, and a clean close", async () => {
  const { open } = installation();
  const refused = open("a");
  refused.host.refuseWith(new Error("no such ref"));
  await expect(refused.handle.ready).rejects.toThrow("no such ref");
  expect(refused.closed).toEqual([{ error: new Error("no such ref") }]);

  const failed = open("b");
  failed.host.acknowledge();
  await failed.handle.ready;
  failed.host.closed("Plugin stopped: diffs");
  expect(failed.closed).toEqual([{ error: new Error("Plugin stopped: diffs") }]);
  await failed.host.released;

  // A handler that returns at once closes in the same tick the host accepts it.
  const finished = open("c");
  finished.host.acknowledge();
  finished.host.closed();
  await expect(finished.handle.ready).resolves.toBeUndefined();
  expect(finished.closed).toEqual([{}]);
});

it("closes a subscription whose event fails the contract and drops what follows", async () => {
  const { open } = installation();
  const { handle, received, closed, host } = open("a");
  host.acknowledge();
  await handle.ready;
  host.event({ path: 3 });
  host.event({ path: "late.ts" });
  expect(received).toEqual([]);
  expect(closed).toEqual([
    { error: new Error("Plugin subscription diff.watch sent an invalid event") },
  ]);
  await host.released;
});

it("releases on its signal, on its remover, and when the installation stops", async () => {
  const { open, lifetime } = installation();
  const controller = new AbortController();
  const bySignal = open("a", controller.signal);
  bySignal.host.acknowledge();
  await bySignal.handle.ready;
  controller.abort();
  await bySignal.host.released;

  const byRemover = open("b");
  byRemover.handle();
  await byRemover.host.released;

  const byLifetime = open("c");
  byLifetime.host.event({ path: "a.ts" });
  expect(byLifetime.received).toEqual(["path:a.ts"]);
  lifetime.abort();
  await byLifetime.host.released;
});
