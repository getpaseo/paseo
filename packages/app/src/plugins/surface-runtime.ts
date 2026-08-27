import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PluginNavigation } from "@getpaseo/plugin";
import { createPluginNavigation } from "./navigation";

export interface PluginSurfaceRuntime {
  paseo: PaseoApi;
  navigation: PluginNavigation;
  invoke(method: string, input: unknown): Promise<unknown>;
}

export function createPluginSurfaceRuntime(
  client: DaemonClient | null,
  pluginId: string,
  serverId: string,
): PluginSurfaceRuntime | null {
  if (!client) return null;
  return {
    paseo: createPaseoApi(client),
    navigation: createPluginNavigation(serverId),
    invoke: (method, input) => client.invokePluginRpc(pluginId, method, input),
  };
}
