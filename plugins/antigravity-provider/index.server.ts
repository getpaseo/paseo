import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createAntigravityProvider } from "./server/provider.js";
import { Usage } from "./server/usage.js";

export default function contribute(
  server: Pick<PluginServerContext, "registerProvider" | "registerUsageSource">,
) {
  const usage = new Usage();
  server.registerUsageSource(usage.registration());
  server.registerProvider(createAntigravityProvider(usage));
  return () => {};
}
