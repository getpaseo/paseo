import type { PluginServerContext } from "@getpaseo/plugin/server";
import { inputSchema } from "./shared/input.js";
import { MiniMaxQuotaProvider } from "./server/usage.js";

export default function contribute(server: PluginServerContext) {
  server.registerUsageSource({
    id: "minimax",
    label: "MiniMax",
    icon: "icon.svg",
    input: inputSchema,
    discover: async () => [{}],
    fetch: async (_input) => new MiniMaxQuotaProvider({ logger: console }).fetchUsage(),
  });
  return () => {};
}
