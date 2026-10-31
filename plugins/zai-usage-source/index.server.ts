import type { PluginServerContext } from "@getpaseo/plugin/server";
import { inputSchema } from "./shared/input.js";
import { fetchUsage, discover } from "./server/usage.js";
import { injectGlmApiKey } from "./server/glm-agent-credentials.js";

export default function contribute(server: PluginServerContext) {
  server.registerUsageSource({
    id: "zai",
    label: "Z.ai",
    icon: "icon.svg",
    input: inputSchema,
    discover: (scope) => (scope.kind === "global" ? discover() : Promise.resolve([])),
    fetch: fetchUsage,
  });

  // The GLM ACP agent reads its Coding Plan key from the environment. When the
  // account is signed in through the ZCode desktop app, that key lives in the
  // app's own store instead, so the agent would start without one and fail
  // every turn with "No API key found".
  server.addHook("agent.create.before", async ({ request }) => {
    return injectGlmApiKey(request);
  });

  return () => {};
}
