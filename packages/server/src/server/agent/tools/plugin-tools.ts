import { z } from "zod";
import type { ProviderPaseoToolsPolicy } from "@getpaseo/protocol/provider-config";
import type { AgentManager } from "../agent-manager.js";
import { isPaseoToolEnabled } from "../paseo-tool-policy.js";
import type { PaseoToolDefinition } from "./types.js";
import { addModelVisibleStructuredContent } from "./paseo-tool-serialization.js";

export function registerPluginTools(options: {
  agentManager: AgentManager;
  callerAgentId?: string;
  scope: "agent" | "top-level";
  tools: Map<string, PaseoToolDefinition>;
  builtinNames: Set<string>;
  policy?: ProviderPaseoToolsPolicy;
}): void {
  const { agentManager, callerAgentId, scope, tools, builtinNames, policy } = options;
  if (scope !== "agent" || !callerAgentId) return;
  for (const tool of agentManager.getPluginTools(callerAgentId)) {
    if (builtinNames.has(tool.name)) {
      throw new Error(
        `Agent tool ${tool.name} from plugin ${tool.pluginId} collides with Paseo tool ${tool.name}`,
      );
    }
    if (!isPaseoToolEnabled(policy, tool.name)) continue;
    tools.set(tool.name, {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: z.fromJSONSchema(tool.inputSchema),
      async handler(input, { signal }) {
        const result = await agentManager.executePluginTool(tool, callerAgentId, input, signal);
        return addModelVisibleStructuredContent({
          content: result.text === undefined ? [] : [{ type: "text", text: result.text }],
          structuredContent: result.structuredContent,
          isError: result.isError,
        });
      },
    });
  }
}
