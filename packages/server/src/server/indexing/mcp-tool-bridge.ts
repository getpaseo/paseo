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
  /**
   * Resolve the workspace cwd at call time. Injected into `repo_root` when
   * the tool accepts it and the caller didn't supply one, so agents get
   * scoped to their own workspace instead of crg's auto-detected root
   * (which is the daemon's cwd — usually the wrong repo).
   */
  getWorkspaceCwd?: () => Promise<string | null> | string | null;
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
          description: decorateDescription(tool),
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
    // Inject repo_root when the tool accepts it and the caller didn't set one.
    // crg's _resolve_repo_root(None) auto-detects from the subprocess cwd,
    // which is the daemon's cwd — almost always NOT the agent's workspace.
    const schemaProps = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)
      ?.properties;
    const acceptsRepoRoot = !!schemaProps && "repo_root" in schemaProps;
    let finalArgs = raw;
    if (acceptsRepoRoot && (!raw || !("repo_root" in raw)) && deps.getWorkspaceCwd) {
      const cwd = await deps.getWorkspaceCwd();
      if (cwd) {
        finalArgs = { ...(raw ?? {}), repo_root: cwd };
      }
    }
    const result = await mcpClient.callTool(tool.name, finalArgs);
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

// Tools that answer "where is X in the codebase?" / "what's the structure?"
// — these should be preferred over raw Read/Grep/Glob because they query a
// pre-built structural + semantic graph that's orders of magnitude faster
// and returns richer results.
const SEARCH_PREFERRED_TOOLS = new Set([
  "crg_semantic_search_nodes",
  "crg_semantic_search_nodes_tool",
  "crg_query_graph",
  "crg_query_graph_tool",
  "crg_get_minimal_context",
  "crg_get_minimal_context_tool",
  "crg_get_impact_radius",
  "crg_get_impact_radius_tool",
  "crg_get_review_context",
  "crg_get_review_context_tool",
  "crg_find_large_functions",
  "crg_find_large_functions_tool",
  "crg_list_graph_stats",
  "crg_list_graph_stats_tool",
  "crg_get_architecture_overview",
  "crg_get_architecture_overview_tool",
  "crg_traverse_graph",
  "crg_traverse_graph_tool",
  "crg_get_hub_nodes",
  "crg_get_hub_nodes_tool",
  "crg_get_bridge_nodes",
  "crg_get_bridge_nodes_tool",
]);

const SEARCH_PREFIX =
  "PREFERRED for codebase exploration — use this BEFORE Read/Grep/Glob when answering " +
  "questions about structure, dependencies, impact, or semantic search. The code-review-graph " +
  "holds a pre-built structural + semantic index of the repo, queries are O(log n), and " +
  "results carry node/edge context that plain text search doesn't. ";

function decorateDescription(tool: CrgToolManifest): string {
  const base = tool.description ?? `Forwarded to code-review-graph: ${tool.name}`;
  if (SEARCH_PREFERRED_TOOLS.has(tool.name)) {
    return `${SEARCH_PREFIX}\n\n${base}`;
  }
  return base;
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
