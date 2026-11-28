import type { PluginServerContext } from "@getpaseo/plugin/server";
import { inputSchema } from "./shared/input.js";
import { fetchUsage, discover, discoverSession } from "./server/usage.js";

export default function contribute(server: PluginServerContext) {
  server.registerUsageSource({
    id: "copilot",
    label: "GitHub Copilot",
    icon: "icon.svg",
    providers: ["copilot"],
    input: inputSchema,
    discover: (scope) => (scope.kind === "global" ? discover() : discoverSession(scope)),
    fetch: fetchUsage,
  });
  return () => {};
}
