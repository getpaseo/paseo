// Lightweight MCP runtime used by the Hubcode agent. Connects to each MCP
// server declared on the session config, lists their tools, exposes a flat
// OpenAI-compatible tools[] array, and routes tool_call invocations back to
// the right server.
//
// Why we need this: the Hubcode backend is a thin OpenAI-compatible proxy. It
// forwards `tools` schemas to the underlying LLM but does NOT execute MCP
// servers — the agent loop has to live in the daemon. Claude/Codex piggyback
// on their SDKs; we do it ourselves here so Hubcode reaches feature parity.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig } from "../agent-sdk-types.js";

/** OpenAI tool entry — the shape we send in chat/completions `tools` field. */
export interface OpenAiTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

interface ToolEntry {
  /** Flat name we expose to the LLM, e.g. "hubcode__open_workspace". */
  flatName: string;
  /** MCP server label this tool belongs to. */
  serverName: string;
  /** Original tool name as exposed by the MCP server. */
  toolName: string;
  description?: string;
  parameters: Record<string, unknown>;
}

interface MinimalLogger {
  warn?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

interface RuntimeDeps {
  servers: Record<string, McpServerConfig>;
  logger?: MinimalLogger;
  /** Override for tests — skips real transports. */
  clientFactory?: (
    serverName: string,
    config: McpServerConfig,
  ) => Promise<{
    listTools: () => Promise<{
      tools: { name: string; description?: string; inputSchema?: unknown }[];
    }>;
    callTool: (args: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>;
    close: () => Promise<void>;
  }>;
}

const FLAT_NAME_SEPARATOR = "__";
const MAX_FLAT_NAME_LENGTH = 64; // OpenAI tool names cap at 64 chars.

export class HubcodeMcpRuntime {
  private readonly servers: Record<string, McpServerConfig>;
  private readonly logger: MinimalLogger;
  private readonly clientFactory: NonNullable<RuntimeDeps["clientFactory"]>;
  private readonly clients = new Map<
    string,
    Awaited<ReturnType<NonNullable<RuntimeDeps["clientFactory"]>>>
  >();
  private toolsCache: ToolEntry[] | null = null;

  constructor(deps: RuntimeDeps) {
    this.servers = deps.servers;
    this.logger = deps.logger ?? {};
    this.clientFactory = deps.clientFactory ?? defaultClientFactory;
  }

  /** Lists the union of tools across all configured servers, OpenAI-shaped. */
  async listOpenAiTools(): Promise<OpenAiTool[]> {
    if (this.toolsCache === null) {
      this.toolsCache = await this.discoverTools();
    }
    return this.toolsCache.map((t) => ({
      type: "function" as const,
      function: {
        name: t.flatName,
        description: t.description,
        parameters: (t.parameters as Record<string, unknown> | undefined) ?? {
          type: "object",
          properties: {},
        },
      },
    }));
  }

  /**
   * Invoke a tool by the flat name we exposed to the LLM. Returns the JSON
   * string the model should see as the `tool` message content.
   */
  async invoke(flatName: string, args: Record<string, unknown>): Promise<string> {
    const entry = (this.toolsCache ?? []).find((t) => t.flatName === flatName);
    if (!entry) {
      return JSON.stringify({ error: `Unknown tool: ${flatName}` });
    }
    const client = await this.ensureClient(entry.serverName);
    try {
      const result = await client.callTool({ name: entry.toolName, arguments: args });
      return jsonStringifyToolResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn?.(`[hubcode-mcp] tool '${flatName}' failed: ${message}`);
      return JSON.stringify({ error: message });
    }
  }

  async close(): Promise<void> {
    for (const [name, client] of this.clients) {
      try {
        await client.close();
      } catch (err) {
        this.logger.debug?.(`[hubcode-mcp] close ${name} failed:`, err);
      }
    }
    this.clients.clear();
    this.toolsCache = null;
  }

  // ── internal ────────────────────────────────────────────────────────────

  private async discoverTools(): Promise<ToolEntry[]> {
    const out: ToolEntry[] = [];
    const taken = new Set<string>();
    for (const serverName of Object.keys(this.servers)) {
      try {
        const client = await this.ensureClient(serverName);
        const list = await client.listTools();
        for (const tool of list.tools ?? []) {
          if (!tool?.name) continue;
          const flat = uniquifyFlatName(toFlatName(serverName, tool.name), taken);
          taken.add(flat);
          out.push({
            flatName: flat,
            serverName,
            toolName: tool.name,
            description: tool.description,
            parameters: (tool.inputSchema as Record<string, unknown> | undefined) ?? {
              type: "object",
              properties: {},
            },
          });
        }
      } catch (err) {
        this.logger.warn?.(
          `[hubcode-mcp] failed to discover tools for '${serverName}':`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return out;
  }

  private async ensureClient(
    serverName: string,
  ): Promise<NonNullable<Awaited<ReturnType<NonNullable<RuntimeDeps["clientFactory"]>>>>> {
    const cached = this.clients.get(serverName);
    if (cached) return cached;
    const cfg = this.servers[serverName];
    if (!cfg) throw new Error(`No MCP server registered for '${serverName}'`);
    const client = await this.clientFactory(serverName, cfg);
    this.clients.set(serverName, client);
    return client;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

/** Flat name = `<server>__<tool>` truncated to 64 chars and sanitized. */
export function toFlatName(serverName: string, toolName: string): string {
  const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  const base = `${sanitize(serverName)}${FLAT_NAME_SEPARATOR}${sanitize(toolName)}`;
  return base.slice(0, MAX_FLAT_NAME_LENGTH);
}

function uniquifyFlatName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  let n = 2;
  let candidate = `${name}_${n}`.slice(0, MAX_FLAT_NAME_LENGTH);
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${name}_${n}`.slice(0, MAX_FLAT_NAME_LENGTH);
  }
  return candidate;
}

/**
 * MCP tool results come as `{ content: [{type:"text", text}], isError?: bool }`.
 * Flatten to a JSON string the LLM can ingest as a `role: "tool"` message.
 */
function jsonStringifyToolResult(result: unknown): string {
  if (!result || typeof result !== "object") return JSON.stringify(result ?? null);
  const r = result as { content?: unknown; isError?: boolean };
  if (Array.isArray(r.content)) {
    const text = (r.content as Array<{ type?: string; text?: string }>)
      .filter((c) => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text!)
      .join("\n");
    if (text) return r.isError ? JSON.stringify({ error: text }) : text;
  }
  return JSON.stringify(result);
}

async function defaultClientFactory(
  _serverName: string,
  config: McpServerConfig,
): Promise<{
  listTools: () => Promise<{
    tools: { name: string; description?: string; inputSchema?: unknown }[];
  }>;
  callTool: (args: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>;
  close: () => Promise<void>;
}> {
  const client = new Client({ name: "hubcode-agent", version: "1.0.0" }, { capabilities: {} });

  if (config.type === "stdio") {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...(process.env as Record<string, string>), ...(config.env ?? {}) },
      stderr: "pipe",
    });
    await client.connect(transport);
  } else {
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: config.headers ? { headers: config.headers } : undefined,
    });
    await client.connect(transport);
  }

  return {
    listTools: async () =>
      (await client.listTools()) as {
        tools: { name: string; description?: string; inputSchema?: unknown }[];
      },
    callTool: async (args) => client.callTool(args),
    close: async () => {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    },
  };
}
