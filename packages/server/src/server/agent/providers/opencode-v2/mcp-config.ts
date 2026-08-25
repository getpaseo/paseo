import type { Logger } from "pino";

import type { McpServerConfig } from "../../agent-sdk-types.js";
import { toDiagnosticErrorMessage } from "../diagnostic-utils.js";
import type { OpenCodeV2ClientLike } from "./client.js";

/**
 * v2 MCP server config shape for `mcp.add`. v2 distinguishes only local vs
 * remote: a stdio server is `{ type: "local", command: [...] }` (with optional
 * cwd/environment), and http/sse servers are `{ type: "remote", url, headers? }`.
 */
export type OpenCodeV2McpConfig =
  | {
      type: "local";
      command: string[];
      cwd?: string;
      environment?: Record<string, string>;
    }
  | {
      type: "remote";
      url: string;
      headers?: Record<string, string>;
    };

const MCP_ALREADY_PRESENT_ERROR_TOKENS = ["already", "exists", "connected"] as const;
const MCP_SERVER_NOT_FOUND_TOKENS = ["not found", "mcp server not found"] as const;

/**
 * How long to wait for a freshly connected MCP server's status to settle before
 * checking it. The opencode2 server transitions a local/remote server to
 * "connected" (or "failed") within ~0.5s of `mcp.connect`, so a short poll
 * makes the tool set ready before the first prompt and surfaces failures.
 */
const MCP_STATUS_SETTLE_TIMEOUT_MS = 5000;
const MCP_STATUS_POLL_INTERVAL_MS = 250;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Map a paseo McpServerConfig (stdio/http/sse) to the v2 `mcp.add` config
 * shape. stdio maps to `local` (command + env vars), http and sse both map to
 * `remote` (v2 has no separate sse config path; the URL carries the transport).
 */
export function toOpenCodeV2McpConfig(config: McpServerConfig): OpenCodeV2McpConfig {
  if (config.type === "stdio") {
    return {
      type: "local",
      command: [config.command, ...(config.args ?? [])],
      ...(config.env ? { environment: config.env } : {}),
    };
  }
  return {
    type: "remote",
    url: config.url,
    ...(config.headers ? { headers: config.headers } : {}),
  };
}

function isAlreadyPresentMcpError(error: unknown): boolean {
  const normalized = toDiagnosticErrorMessage(error).toLowerCase();
  return MCP_ALREADY_PRESENT_ERROR_TOKENS.some((token) => normalized.includes(token));
}

function isMcpServerNotFoundError(error: unknown): boolean {
  const normalized = toDiagnosticErrorMessage(error).toLowerCase();
  return MCP_SERVER_NOT_FOUND_TOKENS.some((token) => normalized.includes(token));
}

function isSettledMcpStatus(status: { status: string }): boolean {
  return status.status !== "pending";
}

/**
 * Reconcile the opencode2 server's MCP servers for one session against the
 * session's desired `mcpServers` config:
 *
 * - Adds + connects every configured server (idempotent: an already-present
 *   server is treated as success, per VAL-OC2-MCP-006).
 * - Removes servers that are present on the server but no longer in the config
 *   (even when the config is empty), so removing an MCP server removes its
 *   tools (VAL-OC2-MCP-009).
 * - Waits briefly for statuses to settle so the tool set is ready before the
 *   first prompt (VAL-OC2-MCP-002).
 *
 * Misconfigured servers fail gracefully: per-server errors are logged and
 * collected as diagnostics, never thrown, so the session is unaffected
 * (VAL-OC2-MCP-005). Returns the diagnostics (one per failed server) for the
 * caller to surface.
 *
 * MCP servers are scoped to the session's location (directory), so this only
 * affects the project the session runs in. On a shared server, agents in the
 * same workspace share MCP state; the last session to reconcile wins for
 * servers that are not in its config (an empty config removes every server in
 * that project). This is inherent to the v2 MCP mechanism.
 */
export async function reconcileOpenCodeV2McpServers(params: {
  client: OpenCodeV2ClientLike;
  mcpServers: Record<string, McpServerConfig> | undefined;
  directory: string;
  logger: Logger;
}): Promise<string[]> {
  const { client, mcpServers, directory, logger } = params;
  const desired = mcpServers ?? {};
  const desiredNames = new Set(Object.keys(desired));
  const diagnostics: string[] = [];
  // Servers that were actually added (or already present) and can be connected.
  const addedNames = new Set<string>();

  for (const [name, serverConfig] of Object.entries(desired)) {
    try {
      await client.mcp.add({
        server: name,
        location: { directory },
        config: toOpenCodeV2McpConfig(serverConfig),
      });
    } catch (error) {
      if (!isAlreadyPresentMcpError(error)) {
        const message = `Failed to add OpenCode 2 MCP server '${name}': ${toDiagnosticErrorMessage(error)}`;
        logger.warn({ err: error, server: name }, "Failed to add OpenCode 2 MCP server");
        diagnostics.push(message);
        continue;
      }
      // Already present is success (idempotent re-inject); still ensure the
      // server is connected below.
    }
    addedNames.add(name);
    try {
      await client.mcp.connect({ server: name, location: { directory } });
    } catch (error) {
      const message = `Failed to connect OpenCode 2 MCP server '${name}': ${toDiagnosticErrorMessage(error)}`;
      logger.warn({ err: error, server: name }, "Failed to connect OpenCode 2 MCP server");
      diagnostics.push(message);
    }
  }

  if (addedNames.size > 0) {
    await waitForMcpStatusesSettled(client, addedNames, directory);
  }

  let listed;
  try {
    listed = await client.mcp.list({ location: { directory } });
  } catch (error) {
    logger.warn({ err: error }, "Failed to list OpenCode 2 MCP servers for reconciliation");
    return diagnostics;
  }

  for (const server of listed.data) {
    if (!desiredNames.has(server.name)) {
      try {
        await client.mcp.remove({ server: server.name, location: { directory } });
        logger.info(
          { server: server.name },
          "Removed OpenCode 2 MCP server that is no longer configured",
        );
      } catch (error) {
        if (isMcpServerNotFoundError(error)) {
          continue;
        }
        logger.warn({ err: error, server: server.name }, "Failed to remove OpenCode 2 MCP server");
      }
      continue;
    }
    if (server.status.status === "failed") {
      const detail = server.status.error ?? "unknown error";
      const message = `OpenCode 2 MCP server '${server.name}' failed: ${detail}`;
      logger.warn({ server: server.name, error: detail }, "OpenCode 2 MCP server failed");
      diagnostics.push(message);
    }
  }

  return diagnostics;
}

async function waitForMcpStatusesSettled(
  client: OpenCodeV2ClientLike,
  names: ReadonlySet<string>,
  directory: string,
): Promise<void> {
  const deadline = Date.now() + MCP_STATUS_SETTLE_TIMEOUT_MS;
  for (;;) {
    try {
      const listed = await client.mcp.list({ location: { directory } });
      const byName = new Map(listed.data.map((server) => [server.name, server.status]));
      const allSettled = Array.from(names).every((name) => {
        const status = byName.get(name);
        // A server absent from the list has nothing left to wait for (its add
        // failed or it was already removed).
        return status === undefined || isSettledMcpStatus(status);
      });
      if (allSettled || Date.now() >= deadline) {
        return;
      }
    } catch {
      // A transient list error is not worth failing the session over.
      return;
    }
    await delay(MCP_STATUS_POLL_INTERVAL_MS);
  }
}
