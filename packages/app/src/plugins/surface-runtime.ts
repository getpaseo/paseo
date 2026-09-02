import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export interface PluginSurfaceRuntime {
  paseo: PaseoApi;
  invoke(method: string, input: unknown): Promise<unknown>;
}

export function createPluginSurfaceRuntime(
  client: DaemonClient | null,
  pluginId: string,
): PluginSurfaceRuntime | null {
  if (!client) return null;
  return {
    paseo: createPaseoApi(client),
    invoke: (method, input) => client.invokePluginRpc(pluginId, method, input),
  };
}
