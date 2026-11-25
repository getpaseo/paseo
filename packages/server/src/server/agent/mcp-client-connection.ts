import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "./agent-sdk-types.js";
import type { PaseoToolResult } from "./tools/types.js";

const SERVER_TIMEOUT_MS = 10_000;

export type McpClientTool = Pick<Tool, "name" | "description" | "inputSchema">;

/**
 * A live MCP client connection that Paseo hosts on behalf of one agent, for providers whose
 * native MCP support cannot be scoped to a single session.
 */
export interface McpClientConnection {
  readonly tools: readonly McpClientTool[];
  /** Server instructions from the initialize result, when the server sends them. */
  readonly instructions: string | undefined;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<PaseoToolResult>;
  close(): Promise<void>;
}

export interface ConnectMcpServerInput {
  config: McpServerConfig;
  /** Working directory for a stdio server. */
  cwd: string;
  /** Complete environment for a stdio server; the server's own `env` overlays it. */
  env: NodeJS.ProcessEnv;
  clientName: string;
}

export async function connectMcpServer(input: ConnectMcpServerInput): Promise<McpClientConnection> {
  const client = new Client({ name: input.clientName, version: "1.0.0" });
  try {
    await client.connect(createTransport(input), { timeout: SERVER_TIMEOUT_MS });
    const listed = await client.listTools(undefined, { timeout: SERVER_TIMEOUT_MS });
    return createConnection(client, listed.tools);
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

function createConnection(client: Client, tools: readonly McpClientTool[]): McpClientConnection {
  let closed: Promise<void> | undefined;
  return {
    tools,
    instructions: client.getInstructions(),
    async callTool(name, args, signal) {
      if (closed) throw new Error(`MCP tool ${name} is unavailable after its connection closed`);
      const raw = await client.callTool({ name, arguments: args }, undefined, { signal });
      const result = CallToolResultSchema.parse(raw);
      return {
        content: result.content.map((item) => ({ ...item })),
        ...(result.structuredContent !== undefined
          ? { structuredContent: result.structuredContent }
          : {}),
        ...(result.isError !== undefined ? { isError: result.isError } : {}),
      };
    },
    close() {
      closed ??= terminate(client);
      return closed;
    },
  };
}

async function terminate(client: Client): Promise<void> {
  // A stateful HTTP server keeps the session until the client ends it explicitly.
  if (client.transport instanceof StreamableHTTPClientTransport)
    await client.transport.terminateSession().catch(() => undefined);
  await client.close().catch(() => undefined);
}

function createTransport({ config, cwd, env }: ConnectMcpServerInput) {
  if (config.type === "stdio") {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      cwd,
      env: definedEnvironment({ ...env, ...config.env }),
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

function definedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
