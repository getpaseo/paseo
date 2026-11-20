import type { PluginServerContext } from "@getpaseo/plugin/server";
import { Usage } from "./server/usage.js";
import { createAntigravityProvider } from "./server/provider.js";

export default function contribute(server: PluginServerContext) {
  const usage = new Usage();
  server.registerUsageSource(usage.registration());
  server.registerProvider(createAntigravityProvider());
  return () => {};
}
