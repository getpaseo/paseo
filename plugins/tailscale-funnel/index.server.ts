import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createTailscaleFunnelProvider } from "./server/tailscale.js";

export default function contribute(server: PluginServerContext) {
  return server.registerTunnelProvider(createTailscaleFunnelProvider());
}
