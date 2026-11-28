import type { PluginServerContext } from "@getpaseo/plugin/server";
import { inputSchema } from "./shared/input.js";
import { discover, discoverSession, fetchUsage } from "./server/usage.js";

export default function contribute(server: PluginServerContext) {
  server.registerUsageSource({
    id: "opencode-go",
    label: "OpenCode Go",
    icon: "icon.svg",
    providers: ["opencode"],
    input: inputSchema,
    discover: (scope) => (scope.kind === "global" ? discover() : discoverSession(scope)),
    fetch: fetchUsage,
  });
  return () => {};
}
