import { createHash } from "node:crypto";
import type { Logger } from "pino";
import type { McpServerConfig } from "../../agent-sdk-types.js";
import { connectMcpServer, type McpClientConnection } from "../../mcp-client-connection.js";
import type { PaseoToolResult } from "../../tools/types.js";
import type { OmpRpcHostToolDefinition } from "./rpc-types.js";

interface BridgedTool {
  connection: McpClientConnection;
  server: string;
  tool: string;
}

export interface OmpBridgedToolIdentity {
  server: string;
  tool: string;
}

export class OmpMcpBridge {
  readonly definitions: OmpRpcHostToolDefinition[] = [];
  private readonly tools = new Map<string, BridgedTool>();
  private readonly connections: McpClientConnection[] = [];
  private closed = false;

  static async connect(
    servers: Record<string, McpServerConfig> | undefined,
    cwd: string,
    logger: Logger,
    env: NodeJS.ProcessEnv,
  ): Promise<OmpMcpBridge> {
    const bridge = new OmpMcpBridge();
    const connections = await Promise.all(
      Object.entries(servers ?? {}).map(async ([serverName, config]) => {
        try {
          const connection = await connectMcpServer({
            config,
            cwd,
            env,
            clientName: "paseo-omp-mcp",
          });
          return { serverName, connection };
        } catch (error) {
          logger.warn({ err: error, server: serverName }, "OMP MCP server unavailable");
          return null;
        }
      }),
    );
    for (const connection of connections) {
      if (!connection) continue;
      const { serverName } = connection;
      bridge.connections.push(connection.connection);
      for (const tool of connection.connection.tools) {
        const name = bridgeName(serverName, tool.name);
        bridge.tools.set(name, {
          connection: connection.connection,
          server: serverName,
          tool: tool.name,
        });
        bridge.definitions.push({
          name,
          label: `${serverName} / ${tool.name}`,
          description: tool.description || `${tool.name} from ${serverName}`,
          loadMode: "essential",
          parameters: tool.inputSchema,
        });
      }
    }
    return bridge;
  }

  tool(name: string): OmpBridgedToolIdentity | undefined {
    const entry = this.tools.get(name);
    return entry ? { server: entry.server, tool: entry.tool } : undefined;
  }

  toolIdentities(): Map<string, OmpBridgedToolIdentity> {
    return new Map(
      [...this.tools].map(([name, entry]) => [name, { server: entry.server, tool: entry.tool }]),
    );
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<PaseoToolResult> {
    const entry = this.tools.get(name);
    if (!entry || this.closed) throw new Error(`MCP tool ${name} is unavailable`);
    return entry.connection.callTool(entry.tool, args, signal);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all(this.connections.map((connection) => connection.close()));
    this.connections.length = 0;
  }
}

function bridgeName(server: string, tool: string): string {
  const key = `${server}\0${tool}`;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 12);
  const clean = (name: string, length: number) =>
    name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, length);
  // 64 characters also fits the stricter model tool-name limits OMP can reach.
  return `mcp_${clean(server, 20)}__${clean(tool, 25)}_${hash}`;
}
