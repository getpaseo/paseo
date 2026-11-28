import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createCustomTunnelProvider } from "./server/tunnel";

export default function contribute(server: PluginServerContext) {
  return server.registerTunnelProvider(createCustomTunnelProvider());
}
