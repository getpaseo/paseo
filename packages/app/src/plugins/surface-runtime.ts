import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export interface PluginSurfaceRuntime {
  paseo: PaseoApi;
  invoke(method: string, input: unknown): Promise<unknown>;
  on(eventName: string, handler: (data: unknown) => void): () => void;
}

export function createPluginSurfaceRuntime(
  client: DaemonClient | null,
  pluginId: string,
): PluginSurfaceRuntime | null {
  if (!client) return null;
  return {
    paseo: createPaseoApi(client),
    invoke: (method, input) => client.invokePluginRpc(pluginId, method, input),
    on: (eventName, handler) =>
      client.subscribe((event) => {
        if (event.type !== "plugin_event") return;
        if (event.pluginId !== pluginId || event.eventName !== eventName) return;
        handler(event.data);
      }),
  };
}
