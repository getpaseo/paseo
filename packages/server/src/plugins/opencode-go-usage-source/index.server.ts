import type { PluginServerContext } from "@getpaseo/plugin/server";
import { inputSchema } from "./shared/input.js";
import { fetchUsage } from "./server/usage.js";

export default function contribute(server: PluginServerContext) {
  server.registerUsageSource({
    id: "opencode-go",
    label: "OpenCode Go",
    icon: "icon.svg",
    input: inputSchema,
    fetch: fetchUsage,
  });
  return () => {};
}
