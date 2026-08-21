import type { AgentMcpReport, AgentMcpServer, McpServerConfig } from "./agent-sdk-types.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Shared MCP-status helpers for providers that need more than a one-line mapping.
 */

/**
 * The servers Paseo handed the provider.
 *
 * The floor for a provider whose runtime will not answer questions about MCP: Paseo
 * wrote the config, so it knows the names without asking anyone. The report is tagged
 * `configured` so the panel can say once that nothing here has been verified, instead
 * of marking every row with a status it has not earned.
 */
export function configuredMcpServers(
  servers: Record<string, McpServerConfig> | undefined,
): AgentMcpReport {
  return {
    servers: Object.keys(servers ?? {})
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, status: "unknown" as const })),
    source: "configured",
  };
}

/**
 * Codex `mcpServerStatus/list`.
 *
 * Codex answers with one entry per configured server and reports the connection by
 * what it fills in rather than by a status string: a server that completed its MCP
 * handshake carries `serverInfo` and its tools, one that did not carries `null`.
 * `authStatus` is the only positive evidence Codex gives for why a server is absent —
 * `unsupported` means the server has no OAuth at all, which is the common case and not
 * a problem.
 */
export function parseCodexMcpServerStatus(raw: unknown): AgentMcpReport {
  const data = asRecord(raw)?.data;
  if (!Array.isArray(data)) {
    throw new Error("codex mcpServerStatus/list did not return a data array");
  }

  const servers: AgentMcpServer[] = [];
  for (const entry of data) {
    const record = asRecord(entry);
    if (!record || typeof record.name !== "string") continue;
    const name = record.name;

    if (!asRecord(record.serverInfo)) {
      // No serverInfo means Codex is not holding this server open, but it does not say
      // why: a server switched off in config looks exactly like one that crashed. Only
      // the auth state is positive evidence, so everything else stays `unknown` rather
      // than accusing a deliberately disabled server of failing.
      servers.push({
        name,
        status: codexNeedsAuth(record.authStatus) ? "needs_auth" : "unknown",
      });
      continue;
    }

    const tools = asRecord(record.tools);
    const server: AgentMcpServer = { name, status: "connected" };
    if (tools) {
      server.toolCount = Object.keys(tools).length;
    }
    servers.push(server);
  }
  return { servers, source: "live" };
}

function codexNeedsAuth(status: unknown): boolean {
  if (typeof status !== "string") return false;
  const normalized = status.toLowerCase();
  // `unsupported` is "this server has no OAuth"; `bearerToken` is "already
  // authenticated". Anything else Codex reports here is a flavour of "log in first".
  return normalized !== "unsupported" && normalized !== "bearertoken";
}
