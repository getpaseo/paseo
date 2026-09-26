import type { PluginServerContext } from "@getpaseo/plugin/server";
import { inputSchema } from "./shared/input.js";
import { KimiQuotaProvider } from "./server/usage.js";

export default function contribute(server: PluginServerContext) {
  server.registerUsageSource({
    id: "kimi",
    label: "Kimi",
    icon: "icon.svg",
    input: inputSchema,
    discover: async () => [{}],
    fetch: async (_input) => new KimiQuotaProvider({ logger: console }).fetchUsage(),
  });
  return () => {};
}
