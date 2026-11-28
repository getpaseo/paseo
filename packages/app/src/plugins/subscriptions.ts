import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PluginSubscribe } from "@getpaseo/plugin/client/host";

/**
 * Plugin subscriptions on the installation's client. The client re-subscribes after a reconnect;
 * the installation's lifetime releases whatever its surfaces left open.
 */
export function createPluginSubscribe(input: {
  client: Pick<DaemonClient, "observePluginRpc">;
  pluginId: string;
  lifetime: AbortSignal;
}): PluginSubscribe {
  const { client, pluginId, lifetime } = input;
  return (method, subscriptionInput, observer) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    lifetime.addEventListener("abort", abort, { once: true });
    controller.signal.addEventListener(
      "abort",
      () => lifetime.removeEventListener("abort", abort),
      { once: true },
    );
    if (lifetime.aborted) controller.abort();
    const subscription = client.observePluginRpc(pluginId, method, subscriptionInput, {
      signal: controller.signal,
    });
    subscription.subscribe({
      snapshot: () => undefined,
      update: (message) => {
        if (message.type === "plugin.rpc.event") observer.event(message.payload.event);
        else if (message.type === "plugin.rpc.closed") {
          controller.abort();
          const error = message.payload.error;
          observer.closed(error === undefined ? undefined : new Error(error));
        }
      },
      binary: (payload) => observer.event(payload),
      error: (error) => {
        controller.abort();
        observer.closed(error instanceof Error ? error : new Error(String(error)));
      },
    });
    const release = () => {
      controller.abort();
      return subscription.release();
    };
    return Object.assign(() => void release().catch(() => undefined), {
      ready: subscription.ready.then(() => undefined),
      release,
    });
  };
}
