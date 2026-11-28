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

export type PluginSessionOpenResult = SessionOpenWireRequest & {
  tools: AttachedAgentTool[];
  mcpServerOwners: Record<string, string>;
};

/** What an open request says about the agent that can change while its session runs. Plugins cannot change it. */
export type SessionOpenAgentFacts = Pick<
  SessionOpenWireRequest,
  "workspaceId" | "title" | "background" | "labels" | "metadata"
>;

export interface PluginSessionRefreshOptions {
  /** Tool names a refreshed plugin tool must not take, beyond the tools other plugins attached. */
  reservedToolNames(): Promise<ReadonlySet<string>>;
  /** The agent as it is now, so a rerun callback sees what a reopen would show it. */
  agentFacts(): Promise<SessionOpenAgentFacts>;
}

/** What the agent manager asks of plugins about a session: its open, its attached tools, and their calls. */
export interface PluginSessionsRuntime {
  /**
   * Runs every `agent.open.before` callback for a session open and records what each plugin attached. The result
   * replaces the running session's record once `sessionLaunched` reports that its provider launch took over.
   */
  openSession(request: SessionOpenWireRequest): Promise<PluginSessionOpenResult>;
  /** The provider session launched with the last open's result. */
  sessionLaunched(agentId: string): void;
  /** The last open's result did not launch; the session still running keeps its tools. */
  sessionLaunchFailed(agentId: string): void;
  /**
   * Reruns the open of only the plugins that changed since the session opened, swaps in their tools, and reports
   * whether the session must reopen to apply the rest.
   */
  refreshSession(
    agentId: string,
    options: PluginSessionRefreshOptions,
  ): Promise<{ stale: boolean }>;
  /** The session's tools from running plugin instances. */
  sessionTools(agentId: string): readonly AttachedAgentTool[];
  closeSession(agentId: string): void;
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
