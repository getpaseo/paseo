import type { PluginServerContext } from "@getpaseo/plugin/server";
import { discover, fetchUsage, inputSchema } from "./server/usage.js";

export default function contribute(server: PluginServerContext) {
  server.registerUsageSource({
    id: "kiro",
    label: "Kiro",
    icon: "icon.svg",
    providers: ["kiro"],
    input: inputSchema,
    discover: (scope) => discover(scope),
    fetch: (input) => fetchUsage(input),
  });
  return () => {};
}
