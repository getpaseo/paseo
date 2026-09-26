import type { PluginServerContext } from "@getpaseo/plugin/server";
import { inputSchema } from "./shared/input.js";
import { GrokQuotaProvider } from "./server/usage.js";

export default function contribute(server: PluginServerContext) {
  server.registerUsageSource({
    id: "grok",
    label: "Grok",
    icon: "icon.svg",
    input: inputSchema,
    discover: async () => [{}],
    fetch: async (_input) => new GrokQuotaProvider({ logger: console }).fetchUsage(),
  });
  return () => {};
}
