import type { PluginServerContext } from "@getpaseo/plugin/server";
import { Usage } from "./server/internal/usage.js";
import { createAntigravityProvider } from "./server/provider.js";

export default function contribute(
  server: Pick<PluginServerContext, "registerProvider" | "registerUsageSource">,
) {
  const usage = new Usage();
  server.registerUsageSource(usage.registration());
  server.registerProvider(createAntigravityProvider(usage));
  return () => {};
}
