import { z } from "zod";
import type {
  AgentToolDefinition,
  AgentToolResult,
  PluginHookContext,
  PluginSessionOpenRequest,
  PluginHookAgent,
} from "@getpaseo/plugin/server";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";

export const agentToolMetadataSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .max(64),
    title: z.string().optional(),
    description: z.string(),
    inputSchema: z.record(z.string(), z.unknown()),
    pluginId: z.string().optional(),
    pluginInstanceId: z.string().optional(),
  })
  .strict();
export type AgentToolMetadata = z.infer<typeof agentToolMetadataSchema>;
export type AttachedAgentTool = AgentToolMetadata & { pluginId: string; pluginInstanceId: string };
export type SessionOpenWireRequest = Omit<PluginSessionOpenRequest, "tools"> & {
  tools: AgentToolMetadata[];
};

export interface PluginAgentToolsRuntime {
  isToolPluginAvailable(pluginId: string, pluginInstanceId: string): boolean;
  detachTools(agentId: string): void;
  callTool(
    pluginId: string,
    pluginInstanceId: string,
    agent: PluginHookAgent,
    name: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<AgentToolResult>;
}

export function serializeAgentTool(tool: AgentToolDefinition): AgentToolMetadata {
  return agentToolMetadataSchema.parse({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: toJsonSchemaCompat(tool.input, { strictUnions: true, pipeStrategy: "input" }),
  });
}

// This store lives only in the plugin process. Definitions and parsed values never cross IPC.
export class PluginAgentTools {
  private readonly agents = new Map<string, AgentToolDefinition[]>();
  private readonly calls = new Map<string, { agentId: string; controller: AbortController }>();

  attach(agentId: string, tools: AgentToolDefinition[]): AgentToolMetadata[] {
    const names = new Set<string>();
    const metadata = tools.map((tool) => {
      const serialized = serializeAgentTool(tool);
      if (names.has(tool.name)) throw new Error(`Duplicate agent tool: ${tool.name}`);
      names.add(tool.name);
      return serialized;
    });
    this.agents.set(agentId, tools);
    return metadata;
  }

  detach(agentId: string): void {
    this.agents.delete(agentId);
    for (const call of this.calls.values()) {
      if (call.agentId === agentId) call.controller.abort();
    }
  }

  cancel(requestId: string): void {
    this.calls.get(requestId)?.controller.abort();
  }

  close(): void {
    for (const call of this.calls.values()) call.controller.abort();
    this.agents.clear();
  }

  async call(
    requestId: string,
    agent: PluginHookAgent,
    name: string,
    input: unknown,
    paseo: PluginHookContext["paseo"],
  ): Promise<AgentToolResult> {
    const controller = new AbortController();
    this.calls.set(requestId, { agentId: agent.id, controller });
    try {
      const tool = this.agents.get(agent.id)?.find((definition) => definition.name === name);
      if (!tool) throw new Error(`Agent tool not attached: ${name}`);
      const parsed = await tool.input.parseAsync(input);
      controller.signal.throwIfAborted();
      const result = await tool.execute(parsed, { agent, paseo, signal: controller.signal });
      controller.signal.throwIfAborted();
      return result;
    } catch (error) {
      return { isError: true, text: error instanceof Error ? error.message : String(error) };
    } finally {
      this.calls.delete(requestId);
    }
  }
}
