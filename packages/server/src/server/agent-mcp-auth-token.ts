import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { ensurePrivateFile, writePrivateFileAtomicSync } from "./private-files.js";

interface LoggerLike {
  child(bindings: Record<string, unknown>): LoggerLike;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

export const AGENT_MCP_AUTH_TOKEN_FILENAME = "agent-mcp-auth-token";

// Accept any RFC 4122 UUID the daemon previously wrote. The value is a local
// capability secret, not a version-specific identifier.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getLogger(logger: LoggerLike | undefined): LoggerLike | undefined {
  return logger?.child({ module: "agent-mcp-auth-token" });
}

export function getAgentMcpAuthTokenPath(paseoHome: string): string {
  return path.join(paseoHome, AGENT_MCP_AUTH_TOKEN_FILENAME);
}

/**
 * Capability token authenticating the daemon's own agents to `/mcp/agents`.
 *
 * Persisted under `$PASEO_HOME` so a daemon restart can re-inject the same
 * bearer into resumed Codex threads. The file is local-only (mode 0600) and is
 * never sent to remote clients.
 */
export function getOrCreateAgentMcpAuthToken(
  paseoHome: string,
  options?: { logger?: LoggerLike },
): string {
  const log = getLogger(options?.logger);
  const tokenPath = getAgentMcpAuthTokenPath(paseoHome);

  if (existsSync(tokenPath)) {
    try {
      ensurePrivateFile(tokenPath);
      const parsed = readFileSync(tokenPath, "utf8").trim();
      if (UUID_RE.test(parsed)) {
        return parsed;
      }
      log?.warn("Ignoring invalid persisted Agent MCP auth token, regenerating");
    } catch (error) {
      log?.warn({ error }, "Failed to read Agent MCP auth token, regenerating");
    }
  }

  const created = randomUUID();
  try {
    writePrivateFileAtomicSync(tokenPath, `${created}\n`);
  } catch (error) {
    log?.warn({ error }, "Failed to persist Agent MCP auth token (continuing in-memory)");
  }
  return created;
}
