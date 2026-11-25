import type { McpServerConfig } from "../../../agent-sdk-types.js";
import { connectMcpServer, type McpClientConnection } from "../../../mcp-client-connection.js";
import type { PaseoToolResult } from "../../../tools/types.js";
import type { OpenCodeBridgeMcpTool } from "../bridge.js";

/** OpenCode's effective name for an MCP tool, which is also its permission action. */
export function openCodeMcpToolName(server: string, tool: string): string {
  return `${normalize(server)}_${normalize(tool)}`;
}

function normalize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

interface SessionMcpTool extends OpenCodeBridgeMcpTool {
  connection: McpClientConnection;
  tool: string;
}

interface ConnectSessionMcpInput {
  servers: Record<string, McpServerConfig>;
  cwd: string;
  /** The agent's complete launch environment, which stdio servers inherit. */
  env: NodeJS.ProcessEnv;
}

/**
 * The MCP servers of one OpenCode session, hosted by Paseo. OpenCode's own MCP configuration is
 * shared by every session in a location, so Paseo connects these servers itself and exposes their
 * tools to this session only, through the Paseo bridge.
 */
export class SessionMcp {
  private closed: Promise<void> | undefined;
  private constructor(
    private readonly servers: ReadonlyArray<{ name: string; connection: McpClientConnection }>,
    private readonly byName: ReadonlyMap<string, SessionMcpTool>,
  ) {}

  static async connect(input: ConnectSessionMcpInput): Promise<SessionMcp> {
    const settled = await Promise.allSettled(
      Object.entries(input.servers).map(async ([name, config]) => {
        try {
          const connection = await connectMcpServer({
            config,
            cwd: input.cwd,
            env: input.env,
            clientName: "paseo-opencode",
          });
          return { name, connection };
        } catch (error) {
          throw new Error(
            `OpenCode MCP server ${name} failed to connect: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      }),
    );
    const servers = settled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    const failure = settled.find((result) => result.status === "rejected");
    const tools = new Map<string, SessionMcpTool>();
    try {
      if (failure) throw failure.reason;
      for (const { name: server, connection } of servers)
        for (const tool of connection.tools) {
          const name = openCodeMcpToolName(server, tool.name);
          if (tools.has(name))
            throw new Error(`OpenCode MCP tool name ${name} is provided by more than one server`);
          tools.set(name, {
            name,
            description: tool.description ?? "",
            inputSchema: tool.inputSchema,
            connection,
            tool: tool.name,
          });
        }
    } catch (error) {
      await Promise.all(servers.map(({ connection }) => connection.close()));
      throw error;
    }
    return new SessionMcp(servers, tools);
  }

  get tools(): OpenCodeBridgeMcpTool[] {
    return [...this.byName.values()].map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }));
  }

  /** Server instructions in the shape OpenCode gives its own MCP servers. */
  get instructions(): string | undefined {
    const servers = this.servers.flatMap(({ name, connection }) =>
      connection.instructions?.trim()
        ? [
            `  <server name="${name}">`,
            ...connection.instructions.split("\n").map((line) => `    ${line}`),
            "  </server>",
          ]
        : [],
    );
    if (!servers.length) return undefined;
    return ["<mcp_instructions>", ...servers, "</mcp_instructions>"].join("\n");
  }

  async execute(name: string, input: unknown, signal?: AbortSignal): Promise<PaseoToolResult> {
    const tool = this.byName.get(name);
    if (!tool) throw new Error(`MCP tool not found: ${name}`);
    const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    return tool.connection.callTool(tool.tool, args, signal);
  }

  close(): Promise<void> {
    this.closed ??= Promise.all(this.servers.map(({ connection }) => connection.close())).then(
      () => undefined,
    );
    return this.closed;
  }
}
