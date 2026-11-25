import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "./agent-sdk-types.js";
import type { PaseoToolResult } from "./tools/types.js";

const SERVER_TIMEOUT_MS = 10_000;
const TERMINATE_TIMEOUT_MS = 2_000;

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
  const { client, tools } = await openClient(input);
  return createConnection(input, client, tools);
}

async function openClient(
  input: ConnectMcpServerInput,
): Promise<{ client: Client; tools: McpClientTool[] }> {
  const client = new Client({ name: input.clientName, version: "1.0.0" });
  try {
    // The SDK times out only the `initialize` request, not the `initialized` notification after it.
    return await withDeadline(
      (async () => {
        await client.connect(createTransport(input));
        const listed = await client.listTools();
        return { client, tools: listed.tools };
      })(),
      SERVER_TIMEOUT_MS,
      () => new Error(`MCP server did not connect within ${SERVER_TIMEOUT_MS / 1000} seconds`),
    );
  } catch (error) {
    // Closing the client also aborts its pending requests.
    await client.close().catch(() => undefined);
    throw error;
  }
}

function createConnection(
  input: ConnectMcpServerInput,
  initial: Client,
  tools: readonly McpClientTool[],
): McpClientConnection {
  let client = initial;
  let renewing: Promise<Client> | undefined;
  let closed: Promise<void> | undefined;
  // A stateful HTTP server forgets a session when it restarts or expires it, and answers 404.
  // The protocol then asks the client to start a new session.
  function renew(stale: Client): Promise<Client> {
    if (client !== stale) return Promise.resolve(client);
    renewing ??= openClient(input)
      .then(async (next) => {
        if (closed) {
          await terminate(next.client);
          throw new Error("MCP connection closed while it reconnected");
        }
        client = next.client;
        void terminate(stale);
        return client;
      })
      .finally(() => {
        renewing = undefined;
      });
    return renewing;
  }
  async function call(
    target: Client,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    const raw = await target.callTool({ name, arguments: args }, undefined, { signal });
    const result = CallToolResultSchema.parse(raw);
    return {
      content: result.content.map((item) => ({ ...item })),
      ...(result.structuredContent !== undefined
        ? { structuredContent: result.structuredContent }
        : {}),
      ...(result.isError !== undefined ? { isError: result.isError } : {}),
    };
  }
  return {
    tools,
    instructions: initial.getInstructions(),
    async callTool(name, args, signal) {
      if (closed) throw new Error(`MCP tool ${name} is unavailable after its connection closed`);
      const target = client;
      try {
        return await call(target, name, args, signal);
      } catch (error) {
        if (!isExpiredSession(error)) throw error;
        return await call(await renew(target), name, args, signal);
      }
    },
    close() {
      // A reconnect that is still running closes its own client once it sees `closed`.
      closed ??= (renewing ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => terminate(client));
      return closed;
    },
  };
}

function isExpiredSession(error: unknown): boolean {
  return error instanceof StreamableHTTPError && error.code === 404;
}

async function terminate(client: Client): Promise<void> {
  // A stateful HTTP server keeps the session until the client ends it explicitly. Closing the
  // client aborts a termination request that the server does not answer in time.
  if (client.transport instanceof StreamableHTTPClientTransport)
    await withDeadline(
      client.transport.terminateSession(),
      TERMINATE_TIMEOUT_MS,
      () => new Error("MCP session termination timed out"),
    ).catch(() => undefined);
  await client.close().catch(() => undefined);
}

/** Settles with the operation, or rejects with `timeout()` when `ms` passes first. */
async function withDeadline<T>(
  operation: Promise<T>,
  ms: number,
  timeout: () => unknown,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeout()), ms);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
  }
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
