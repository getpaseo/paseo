import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Logger } from "pino";

/**
 * Probe an MCP server config end-to-end: establish transport, initialize the
 * session, list tools, tear down. Used by the Library detail modal so users
 * can validate a catalog entry before sync'ing it to their agents.
 *
 * The probe MUST be bounded — a hanging stdio child or a non-responsive HTTP
 * server should resolve within ~10s, not lock the UI.
 */

export type McpTestRequest =
  | {
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      transport: "http" | "sse";
      url: string;
      headers?: Record<string, string>;
    };

export interface McpTestResult {
  ok: boolean;
  /** Wire latency from connect → listTools. */
  durationMs: number;
  /** Tool names (capped). */
  tools: string[];
  toolCount: number;
  /** Server-reported name + version from initialize. */
  serverInfo?: { name?: string; version?: string };
  error?: string;
}

const PROBE_TIMEOUT_MS = 10_000;
const MAX_TOOLS_RETURNED = 50;

export async function runMcpTest(req: McpTestRequest, logger: Logger): Promise<McpTestResult> {
  const start = Date.now();
  const client = new Client(
    { name: "hubcode-library-test", version: "1.0.0" },
    { capabilities: {} },
  );
  let transport: StdioClientTransport | StreamableHTTPClientTransport | null = null;
  try {
    if (req.transport === "stdio") {
      if (!req.command?.trim()) throw new Error("Command is required for stdio transport");
      transport = new StdioClientTransport({
        command: req.command.trim(),
        args: req.args ?? [],
        env: { ...(process.env as Record<string, string>), ...(req.env ?? {}) },
        stderr: "pipe",
      });
    } else {
      if (!req.url?.trim()) throw new Error("URL is required for HTTP/SSE transport");
      transport = new StreamableHTTPClientTransport(new URL(req.url.trim()), {
        requestInit: req.headers ? { headers: req.headers } : undefined,
      });
    }

    await withTimeout(client.connect(transport), PROBE_TIMEOUT_MS, "connect timed out");
    const tools = await withTimeout(client.listTools(), PROBE_TIMEOUT_MS, "listTools timed out");
    const toolNames = (tools.tools ?? []).map((t) => t.name).filter(Boolean);
    const info = client.getServerVersion();
    return {
      ok: true,
      durationMs: Date.now() - start,
      tools: toolNames.slice(0, MAX_TOOLS_RETURNED),
      toolCount: toolNames.length,
      serverInfo: info ? { name: info.name, version: info.version } : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug({ err }, "MCP library test failed");
    return {
      ok: false,
      durationMs: Date.now() - start,
      tools: [],
      toolCount: 0,
      error: message,
    };
  } finally {
    try {
      await client.close();
    } catch {
      /* best effort */
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
