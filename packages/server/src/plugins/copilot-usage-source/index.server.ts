import type { PluginServerContext } from "@getpaseo/plugin/server";
import { inputSchema } from "./shared/input.js";
import { fetchUsage } from "./server/usage.js";

export default function contribute(server: PluginServerContext) {
  server.registerUsageSource({
    id: "copilot",
    label: "GitHub Copilot",
    icon: "icon.svg",
    input: inputSchema,
    discover: async () => [{}],
    fetch: fetchUsage,
  });
  return () => {};
}
