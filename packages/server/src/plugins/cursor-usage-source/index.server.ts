import type { PluginServerContext } from "@getpaseo/plugin/server";
import { inputSchema } from "./shared/input.js";
import { CursorQuotaProvider } from "./server/usage.js";

export default function contribute(server: PluginServerContext) {
  server.registerUsageSource({
    id: "cursor",
    label: "Cursor",
    icon: "icon.svg",
    input: inputSchema,
    discover: async () => [{}],
    fetch: async (_input) => new CursorQuotaProvider({ logger: console }).fetchUsage(),
  });
  return () => {};
}
