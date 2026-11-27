import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createCloudflaredTunnelProvider } from "./server/cloudflared.js";
import { cloudflaredSettings, type CloudflaredSettings } from "./shared/settings.js";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(cloudflaredSettings);

  const readSettings = async (): Promise<CloudflaredSettings> => {
    const state = await settings.read();
    return state.status === "ready" ? state.values : {};
  };

  return server.registerTunnelProvider(createCloudflaredTunnelProvider({ readSettings }));
}
