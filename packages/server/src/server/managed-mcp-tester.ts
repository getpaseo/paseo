import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig } from "./agent/agent-sdk-types.js";

const DEFAULT_TEST_TIMEOUT_MS = 15_000;
const MAX_TEST_ERROR_LENGTH = 2_000;

export interface ManagedMcpTestResult {
  status: "success" | "error";
  latencyMs: number;
  toolCount?: number;
  error?: string;
}

function processEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value]],
    ),
  );
}

function createTransport(config: McpServerConfig): Transport {
  if (config.type === "stdio") {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env ? { ...processEnvironment(), ...config.env } : undefined,
    });
  }
  const requestInit = config.headers ? { headers: config.headers } : undefined;
  if (config.type === "sse") {
    return new SSEClientTransport(new URL(config.url), { requestInit });
  }
  return new StreamableHTTPClientTransport(new URL(config.url), { requestInit });
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Connection timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sanitizeError(error: unknown, secrets: readonly string[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [...new Set(secrets)].sort((left, right) => right.length - left.length)) {
    if (secret) message = message.replaceAll(secret, "[redacted]");
  }
  return message.slice(0, MAX_TEST_ERROR_LENGTH);
}

function configuredSecrets(config: McpServerConfig): string[] {
  const values = config.type === "stdio" ? config.env : config.headers;
  return Object.values(values ?? {});
}

export async function testManagedMcpServer(params: {
  config: McpServerConfig;
  timeoutMs?: number;
  now?: () => number;
}): Promise<ManagedMcpTestResult> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  const now = params.now ?? Date.now;
  const startedAt = now();
  const deadline = Date.now() + timeoutMs;
  const client = new Client({ name: "paseo-mcp-connection-test", version: "1.0.0" });
  const transport = createTransport(params.config);
  const remainingMs = () => Math.max(1, deadline - Date.now());

  try {
    await withTimeout(client.connect(transport), remainingMs());
    const tools = await withTimeout(client.listTools(), remainingMs());
    return {
      status: "success",
      latencyMs: Math.max(0, now() - startedAt),
      toolCount: tools.tools.length,
    };
  } catch (error) {
    return {
      status: "error",
      latencyMs: Math.max(0, now() - startedAt),
      error: sanitizeError(error, configuredSecrets(params.config)),
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
