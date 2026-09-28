import type { PluginServerContext } from "@getpaseo/plugin/server";
import { inputSchema } from "./shared/input.js";
import { discover, fetchUsage, identify } from "./server/usage.js";

export default function contribute(server: PluginServerContext) {
  server.registerUsageSource({
    id: "opencode-go",
    label: "OpenCode Go",
    icon: "icon.svg",
    input: inputSchema,
    discover,
    identify,
    fetch: fetchUsage,
  });
  return () => {};
}
