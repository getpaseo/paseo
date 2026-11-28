import type { PluginServerContext } from "@getpaseo/plugin/server";
import { inputSchema } from "./shared/input.js";
import { fetchUsage, discover, discoverSession } from "./server/usage.js";

export default function contribute(server: PluginServerContext) {
  server.registerUsageSource({
    id: "kimi",
    label: "Kimi",
    icon: "icon.svg",
    providers: ["kimi"],
    input: inputSchema,
    discover: (scope) => (scope.kind === "global" ? discover() : discoverSession(scope)),
    fetch: fetchUsage,
  });
  return () => {};
}
