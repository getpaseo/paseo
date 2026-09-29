import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "pino";
import type { McpServerConfig } from "../../agent-sdk-types.js";
import type { PaseoToolResult } from "../../tools/types.js";
import type { OmpRuntimeSession } from "./runtime.js";
import type { OmpRpcHostToolDefinition } from "./rpc-types.js";

interface BridgedTool {
  client: Client;
  tool: string;
}

export class OmpMcpBridge {
  readonly definitions: OmpRpcHostToolDefinition[] = [];
  private readonly tools = new Map<string, BridgedTool>();
  private readonly clients: Client[] = [];
  private closed = false;

  static async connect(
    servers: Record<string, McpServerConfig> | undefined,
    cwd: string,
    logger: Logger,
    reservedNames: Iterable<string> = [],
    skipPaseoEndpoint = false,
  ): Promise<OmpMcpBridge> {
    const bridge = new OmpMcpBridge();
    const usedNames = new Set(reservedNames);
    for (const [serverName, config] of Object.entries(servers ?? {})) {
      // AgentManager removes its injected endpoint when native Paseo tools are present.
      // Also cover direct provider callers that pass the runtime endpoint themselves.
      if (skipPaseoEndpoint && isPaseoEndpoint(config)) continue;
      const client = new Client({ name: "paseo-omp-mcp", version: "1.0.0" });
      try {
        const transport = makeTransport(config, cwd);
        await client.connect(transport);
        const listed = await client.listTools();
        bridge.clients.push(client);
        for (const tool of listed.tools) {
          const baseName = bridgeName(serverName, tool.name);
          let name = baseName;
          for (let suffix = 2; usedNames.has(name); suffix += 1) {
            const ending = `_${suffix}`;
            name = `${baseName.slice(0, -13).slice(0, 64 - ending.length - 13)}${ending}${baseName.slice(-13)}`;
          }
          usedNames.add(name);
          bridge.tools.set(name, { client, tool: tool.name });
          bridge.definitions.push({
            name,
            label: `${serverName} / ${tool.name}`,
            description: tool.description || `${tool.name} from ${serverName}`,
            loadMode: "essential",
            parameters: tool.inputSchema,
          });
        }
      } catch (error) {
        logger.warn({ err: error, server: serverName }, "OMP MCP server unavailable");
        await client.close().catch(() => undefined);
      }
    }
    return bridge;
  }

  has(name: string): boolean {
    return this.tools.has(name);
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

const bridges = new WeakMap<OmpRuntimeSession, OmpMcpBridge>();

export function attachOmpMcpBridge(runtime: OmpRuntimeSession, bridge: OmpMcpBridge): void {
  bridges.set(runtime, bridge);
}

export function getOmpMcpBridge(runtime: OmpRuntimeSession): OmpMcpBridge | undefined {
  return bridges.get(runtime);
}

export async function closeOmpMcpBridge(runtime: OmpRuntimeSession): Promise<void> {
  const bridge = bridges.get(runtime);
  bridges.delete(runtime);
  await bridge?.close();
}

function makeTransport(config: McpServerConfig, cwd: string) {
  if (config.type === "stdio") {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      cwd,
      env: { ...process.env, ...config.env } as Record<string, string>,
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

function isPaseoEndpoint(config: McpServerConfig): boolean {
  if (config.type === "stdio") return false;
  try {
    return new URL(config.url).pathname === "/mcp/agents";
  } catch {
    return false;
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
