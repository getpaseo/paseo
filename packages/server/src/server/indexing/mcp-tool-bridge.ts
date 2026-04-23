import type { Logger } from "pino";
import { z } from "zod";

import type { CrgMcpClient } from "./mcp-client.js";
import type { IndexingState } from "./types.js";
import { authorizeToolCall, type CrgToolManifest } from "./tool-filter.js";

/**
 * Minimal slice of the MCP SDK `McpServer` used by the bridge. Having our
 * own interface lets tests pass a fake without importing the SDK.
 */
export interface RegisterableMcpServer {
  registerTool(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: Record<string, z.ZodType>;
    },
    handler: (args: unknown) => Promise<{
      content: Array<{ type: "text"; text: string }>;
      isError?: boolean;
    }>,
  ): void;
}

export interface CrgToolBridgeDeps {
  logger: Logger;
  server: RegisterableMcpServer;
  mcpClient: CrgMcpClient;
  /**
   * Identity of the MCP caller. Typically resolved from the calling agent
   * (`claude-code`, `codex`, etc.). When null, the bridge skips registering
   * tools (anonymous callers have no scoping).
   */
  agentId: string | null;
  /** Resolve the workspace state at *call* time, so mid-session toggles apply. */
  getIndexingState: () => Promise<IndexingState | null> | IndexingState | null;
}

/**
 * Register the crg tools on the given MCP server, with per-call
 * authorization against the caller's `agentId`.
 *
 * This runs at MCP-server-construction time (once per session). Tools are
 * registered as all-of-them; authorization happens inside each handler, so
 * runtime toggles (user enabling/disabling a tool mid-session) are honored
 * without restarting the agent. The downside is that `tools/list` shows
 * everything; fine-grained list filtering lands in a later PR that wires
 * `notifications/tools/list_changed` broadcasts.
 */
export function registerCrgToolsOnServer(deps: CrgToolBridgeDeps): {
  registered: number;
  skippedReason?: string;
} {
  const { logger, server, mcpClient, agentId } = deps;
  if (!agentId) {
    return { registered: 0, skippedReason: "No caller agentId" };
  }
  if (!mcpClient.isConnected()) {
    return { registered: 0, skippedReason: "crg MCP client not connected" };
  }
  const tools = mcpClient.getCachedTools();
  if (tools.length === 0) {
    return { registered: 0, skippedReason: "crg tool cache is empty" };
  }
  let registered = 0;
  for (const tool of tools) {
    try {
      server.registerTool(
        tool.name,
        {
          title: prettifyTitle(tool.name),
          description: tool.description ?? `Forwarded to code-review-graph: ${tool.name}`,
          inputSchema: passthroughInputSchema(tool),
        },
        async (args: unknown) => handleCall(deps, agentId, tool, args),
      );
      registered += 1;
    } catch (err) {
      logger.warn({ err, name: tool.name }, "Failed to register crg tool; skipping");
    }
  }
  return { registered };
}

async function handleCall(
  deps: CrgToolBridgeDeps,
  agentId: string,
  tool: CrgToolManifest,
  args: unknown,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { mcpClient, getIndexingState, logger } = deps;
  const state = await getIndexingState();
  if (!state) {
    return textError(
      `Code indexing is not configured for this workspace; cannot call ${tool.name}.`,
    );
  }
  const auth = authorizeToolCall(state, agentId, tool.name);
  if (!auth.ok) {
    return textError(auth.reason);
  }
  if (!mcpClient.isConnected()) {
    return textError(`code-review-graph is not connected; cannot call ${tool.name}.`);
  }
  try {
    const raw =
      typeof args === "object" && args !== null ? (args as Record<string, unknown>) : undefined;
    const result = await mcpClient.callTool(tool.name, raw);
    return normalizeToolResult(result);
  } catch (err) {
    logger.warn({ err, name: tool.name }, "crg tool call failed");
    const msg = err instanceof Error ? err.message : String(err);
    return textError(`Tool ${tool.name} failed: ${msg}`);
  }
}

function prettifyTitle(name: string): string {
  return name.replace(/^crg_/, "").replace(/_/g, " ");
}

/**
 * crg exposes JSON-schema input shapes; the MCP SDK's registerTool expects
 * zod shapes. For PR3c we register a passthrough (any record) — the child
 * does the real schema validation. A later PR can translate schemas if
 * needed.
 */
function passthroughInputSchema(_tool: CrgToolManifest): Record<string, z.ZodType> {
  // Empty shape → the SDK accepts any object; payload is forwarded as-is.
  return {};
}

function normalizeToolResult(result: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  if (result && typeof result === "object") {
    const r = result as { content?: unknown; isError?: boolean };
    if (Array.isArray(r.content)) {
      const text = r.content
        .map((entry) => {
          if (
            entry &&
            typeof entry === "object" &&
            "text" in entry &&
            typeof (entry as { text?: unknown }).text === "string"
          ) {
            return String((entry as { text: string }).text);
          }
          return JSON.stringify(entry);
        })
        .join("");
      return {
        content: [{ type: "text", text }],
        isError: r.isError === true ? true : undefined,
      };
    }
  }
  return {
    content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
  };
}

function textError(message: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return { content: [{ type: "text", text: message }], isError: true };
}
