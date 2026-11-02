/**
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { useRpc, useSubscription } from "@getpaseo/plugin/client";
import { PluginTranslationRuntime, subscribePluginRpc } from "@getpaseo/plugin/client/host";
import type { PaseoApi } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { SubscriptionObserver } from "@getpaseo/client";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { QueryClient } from "@tanstack/react-query";
import React, { type ReactNode } from "react";
import { expect, it } from "vitest";
import { z } from "zod";
import { PluginInstallationProvider } from "./installation-provider";
import { createPluginSubscribe } from "./subscriptions";
import type { InstalledPlugin } from "./types";

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

function host() {
  const subscriptions: HostSubscription[] = [];
  const client = {
    observePluginRpc: (...[pluginId, method, input, options]: Observed) => {
      expect(pluginId).toBe("diffs");
      const subscription = new HostSubscription(method, input, options?.signal);
      subscriptions.push(subscription);
      return subscription.handle() as unknown as ReturnType<DaemonClient["observePluginRpc"]>;
    },
  };
  return { client, subscriptions };
}

function installation(input: {
  client: ReturnType<typeof host>["client"];
  invoke?: InstalledPlugin["invoke"];
}): InstalledPlugin {
  const lifetime = new AbortController();
  return {
    id: "diffs",
    serverId: "host",
    clientBundle: "",
    lifetime,
    locale: "en",
    i18n: new PluginTranslationRuntime({ getLocale: () => "en", subscribe: () => () => {} }),
    paseo: { dispose: async () => undefined } as PaseoApi,
    invoke: input.invoke ?? (async () => undefined),
    subscribe: createPluginSubscribe({
      client: input.client,
      pluginId: "diffs",
      lifetime: lifetime.signal,
    }),
    queryClient: new QueryClient(),
    cleanup: () => undefined,
    settingsScreens: [],
    surfaces: [],
    sidebarItems: { header: [], footer: [] },
    legacySidebarItems: [],
    filePanels: [],
    workspacePanels: [],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
  };
}

function wrapper(plugin: InstalledPlugin) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <PluginInstallationProvider plugin={plugin}>{children}</PluginInstallationProvider>;
  };
}

it("useSubscription goes live, delivers JSON and bytes to the latest callback, and releases on unmount", async () => {
  const { client, subscriptions } = host();
  const plugin = installation({ client });
  const received: string[] = [];
  const { result, rerender, unmount } = renderHook(
    ({ label }: { label: string }) =>
      useSubscription(changes, { ref: "main" }, (event) => {
        received.push(
          event instanceof Uint8Array ? `${label}:bytes:${[...event]}` : `${label}:${event.path}`,
        );
      }),
    { wrapper: wrapper(plugin), initialProps: { label: "first" } },
  );

  expect(result.current).toEqual({ status: "connecting" });
  const [subscription] = subscriptions;
  expect(subscription.method).toBe("diff.watch");
  expect(subscription.input).toEqual({ ref: "main" });
  await act(async () => subscription.acknowledge());
  expect(result.current).toEqual({ status: "live" });

  act(() => subscription.event({ path: "a.ts" }));
  rerender({ label: "second" });
  act(() => subscription.bytes(new Uint8Array([1, 2])));
  expect(received).toEqual(["first:a.ts", "second:bytes:1,2"]);
  // A new callback is not a new subscription.
  expect(subscriptions).toHaveLength(1);

  unmount();
  await subscription.released;
});

it("useSubscription subscribes again when its input changes shallowly", async () => {
  const { client, subscriptions } = host();
  const plugin = installation({ client });
  const { rerender } = renderHook(
    ({ ref }: { ref: string }) => useSubscription(changes, { ref }, () => undefined),
    { wrapper: wrapper(plugin), initialProps: { ref: "main" } },
  );
  rerender({ ref: "main" });
  expect(subscriptions).toHaveLength(1);
  rerender({ ref: "next" });
  expect(subscriptions).toHaveLength(2);
  await subscriptions[0].released;
  expect(subscriptions[1].input).toEqual({ ref: "next" });
  expect(subscriptions[1].isReleased).toBe(false);
});

it("useSubscription reports a refusal, a failure after going live, and a clean close", async () => {
  const { client, subscriptions } = host();
  const plugin = installation({ client });
  const refused = renderHook(() => useSubscription(changes, { ref: "a" }, () => undefined), {
    wrapper: wrapper(plugin),
  });
  await act(async () => subscriptions[0].refuseWith(new Error("no such ref")));
  expect(refused.result.current).toMatchObject({
    status: "error",
    error: { message: "no such ref" },
  });

  const failed = renderHook(() => useSubscription(changes, { ref: "b" }, () => undefined), {
    wrapper: wrapper(plugin),
  });
  await act(async () => subscriptions[1].acknowledge());
  act(() => subscriptions[1].closed("Plugin stopped: diffs"));
  expect(failed.result.current).toMatchObject({
    status: "error",
    error: { message: "Plugin stopped: diffs" },
  });
  await subscriptions[1].released;

  const finished = renderHook(() => useSubscription(changes, { ref: "c" }, () => undefined), {
    wrapper: wrapper(plugin),
  });
  await act(async () => subscriptions[2].acknowledge());
  act(() => subscriptions[2].closed());
  expect(finished.result.current).toEqual({ status: "closed" });

  // A handler that returns at once closes in the same tick the host accepts it.
  const immediate = renderHook(() => useSubscription(changes, { ref: "d" }, () => undefined), {
    wrapper: wrapper(plugin),
  });
  await act(async () => {
    subscriptions[3].acknowledge();
    subscriptions[3].closed();
  });
  expect(immediate.result.current).toEqual({ status: "closed" });
});

it("an event that fails the contract closes the subscription with an error", async () => {
  const { client, subscriptions } = host();
  const plugin = installation({ client });
  const received: unknown[] = [];
  const { result } = renderHook(
    () => useSubscription(changes, { ref: "a" }, (event) => received.push(event)),
    { wrapper: wrapper(plugin) },
  );
  await act(async () => subscriptions[0].acknowledge());
  act(() => subscriptions[0].event({ path: 3 }));
  expect(received).toEqual([]);
  expect(result.current).toMatchObject({
    status: "error",
    error: { message: "Plugin subscription diff.watch sent an invalid event" },
  });
  await subscriptions[0].released;
});

it("client.subscribe releases on its signal, on its remover, and when the installation stops", async () => {
  const { client, subscriptions } = host();
  const plugin = installation({ client });
  const subscribe = <Event,>(onEvent: (event: Event) => void, signal?: AbortSignal) =>
    subscribePluginRpc(changes, plugin.subscribe, { ref: "main" }, onEvent as never, { signal });

  const controller = new AbortController();
  const bySignal = subscribe(() => undefined, controller.signal);
  subscriptions[0].acknowledge();
  await bySignal.ready;
  controller.abort();
  await subscriptions[0].released;

  const byRemover = subscribe(() => undefined);
  byRemover();
  await subscriptions[1].released;

  const received: unknown[] = [];
  subscribe((event) => received.push(event));
  subscriptions[2].event({ path: "a.ts" });
  expect(received).toEqual([{ path: "a.ts" }]);
  plugin.lifetime.abort();
  await subscriptions[2].released;
});

it("useRpc resolves a binary output as bytes", async () => {
  const thumbnail = defineRpc({
    name: "thumbnail.render",
    input: z.object({ path: z.string() }),
    output: z.instanceof(Uint8Array),
  });
  const plugin = installation({
    client: host().client,
    invoke: async (method, input) => {
      expect(method).toBe("thumbnail.render");
      expect(input).toEqual({ path: "a.png" });
      return new Uint8Array([137, 80, 78, 71]);
    },
  });
  const { result } = renderHook(() => useRpc(thumbnail), { wrapper: wrapper(plugin) });
  await waitFor(async () => {
    const bytes = await result.current({ path: "a.png" });
    expect([...bytes]).toEqual([137, 80, 78, 71]);
  });
});
