import { createPaseoPluginApi, type PaseoPluginApi } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export interface PluginSurfaceRuntime {
  paseo: PaseoPluginApi;
  invoke(method: string, input: unknown): Promise<unknown>;
  readonly callerAgentId: string | null;
}

export function createPluginSurfaceRuntime(
  client: DaemonClient | null,
  pluginId: string,
  callerAgentId?: string | null,
): PluginSurfaceRuntime | null {
  if (!client) return null;
  return {
    paseo: createPaseoPluginApi(client),
    callerAgentId: callerAgentId ?? null,
    invoke: (method, input) => {
      if (callerAgentId === undefined) return client.invokePluginRpc(pluginId, method, input);
      return client.invokePluginRpc(pluginId, method, input, { callerAgentId });
    },
  };
}
