import type { PluginServerContext } from "@getpaseo/plugin/server";
import { inputSchema } from "./shared/input.js";
import { fetchUsage, discover } from "./server/usage.js";

export default function contribute(server: PluginServerContext) {
  server.registerUsageSource({
    id: "cursor",
    label: "Cursor",
    icon: "icon.svg",
    input: inputSchema,
    discover: () => discover(),
    fetch: fetchUsage,
  });
  return () => {};
}
