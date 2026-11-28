import { z } from "zod";
import type { DaemonPermission } from "@getpaseo/protocol/messages";
import type { ProviderPaseoToolsPolicy } from "@getpaseo/protocol/provider-config";
import type { AgentManager } from "../agent-manager.js";
import { isPaseoToolEnabled } from "../paseo-tool-policy.js";
import type { PaseoToolDefinition } from "./types.js";
import { addModelVisibleStructuredContent } from "./paseo-tool-serialization.js";

const PLUGIN_TOOL_PERMISSION: DaemonPermission = "workspace.write";

export function registerPluginTools(options: {
  agentManager: AgentManager;
  callerAgentId?: string;
  scope: "agent" | "top-level";
  toolsEnabled?: boolean;
  allowedPermissions?: ReadonlySet<DaemonPermission>;
  tools: Map<string, PaseoToolDefinition>;
  builtinNames: Set<string>;
  policy?: ProviderPaseoToolsPolicy;
}): void {
  const {
    agentManager,
    callerAgentId,
    scope,
    toolsEnabled = true,
    allowedPermissions,
    tools,
    builtinNames,
    policy,
  } = options;
  if (scope !== "agent" || !callerAgentId || !toolsEnabled) return;
  if (allowedPermissions && !allowedPermissions.has(PLUGIN_TOOL_PERMISSION)) return;
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
      group: "plugin",
      scope: "agent",
      permission: PLUGIN_TOOL_PERMISSION,
      inputSchema: z.fromJSONSchema(tool.inputSchema),
      async handler(input, { signal }) {
        const result = await agentManager.executePluginTool({
          pluginId: tool.pluginId,
          toolName: tool.name,
          agentId: callerAgentId,
          input,
          signal,
        });
        return addModelVisibleStructuredContent({
          content: result.text === undefined ? [] : [{ type: "text", text: result.text }],
          structuredContent: result.structuredContent,
          isError: result.isError,
        });
      },
    });
  }
}
