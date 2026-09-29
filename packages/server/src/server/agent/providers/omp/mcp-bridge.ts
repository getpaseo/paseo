import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "pino";
import type { McpServerConfig } from "../../agent-sdk-types.js";
import type { PaseoToolResult } from "../../tools/types.js";
import type { OmpRpcHostToolDefinition } from "./rpc-types.js";

interface BridgedTool {
  client: Client;
  server: string;
  tool: string;
}

export interface OmpBridgedToolIdentity {
  server: string;
  tool: string;
}

const SERVER_TIMEOUT_MS = 10_000;

export class OmpMcpBridge {
  readonly definitions: OmpRpcHostToolDefinition[] = [];
  private readonly tools = new Map<string, BridgedTool>();
  private readonly clients: Client[] = [];
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
        const client = new Client({ name: "paseo-omp-mcp", version: "1.0.0" });
        try {
          const transport = makeTransport(config, cwd, env);
          await client.connect(transport, { timeout: SERVER_TIMEOUT_MS });
          const listed = await client.listTools(undefined, { timeout: SERVER_TIMEOUT_MS });
          return { serverName, client, tools: listed.tools };
        } catch (error) {
          logger.warn({ err: error, server: serverName }, "OMP MCP server unavailable");
          await client.close().catch(() => undefined);
          return null;
        }
      }),
    );
    for (const connection of connections) {
      if (!connection) continue;
      const { serverName, client, tools } = connection;
      bridge.clients.push(client);
      for (const tool of tools) {
        const name = bridgeName(serverName, tool.name);
        bridge.tools.set(name, { client, server: serverName, tool: tool.name });
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
    const raw = await entry.client.callTool({ name: entry.tool, arguments: args }, undefined, {
      signal,
    });
    const result = CallToolResultSchema.parse(raw);
    return {
      content: result.content.map((item) => ({ ...item })),
      ...(result.structuredContent !== undefined
        ? { structuredContent: result.structuredContent }
        : {}),
      ...(result.isError !== undefined ? { isError: result.isError } : {}),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all(this.clients.map((client) => client.close().catch(() => undefined)));
    this.clients.length = 0;
  }
}

function makeTransport(config: McpServerConfig, cwd: string, env: NodeJS.ProcessEnv) {
  if (config.type === "stdio") {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      cwd,
      env: { ...env, ...config.env } as Record<string, string>,
      stderr: "ignore",
    });
  }
  if (config.type === "http") {
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers },
    });
  }
  return new SSEClientTransport(new URL(config.url), {
    requestInit: { headers: config.headers },
    eventSourceInit: {
      fetch: (url, init) =>
        fetch(url, { ...init, headers: { ...init?.headers, ...config.headers } }),
    },
  });
}

function bridgeName(server: string, tool: string): string {
  const key = `${server}\0${tool}`;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 12);
  const clean = (name: string, length: number) =>
    name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, length);
  // 64 characters also fits the stricter model tool-name limits OMP can reach.
  return `mcp_${clean(server, 20)}__${clean(tool, 25)}_${hash}`;
}
