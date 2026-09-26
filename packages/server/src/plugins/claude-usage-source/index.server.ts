import type { PluginServerContext } from "@getpaseo/plugin/server";
import { inputSchema } from "./shared/input.js";
import { ClaudeQuotaProvider } from "./server/usage.js";

export default function contribute(server: PluginServerContext) {
  server.registerUsageSource({
    id: "claude",
    label: "Claude",
    icon: "icon.svg",
    input: inputSchema,
    discover: async () => [{}],
    fetch: async (input) => {
      const parsed = inputSchema.parse(input);
      return new ClaudeQuotaProvider({
        logger: console,
        ...("configDir" in parsed ? { configDir: parsed.configDir } : {}),
        ...("accessToken" in parsed ? { accessToken: parsed.accessToken } : {}),
      }).fetchUsage();
    },
  });
  return () => {};
}
