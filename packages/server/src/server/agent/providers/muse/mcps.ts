import type { Logger } from "pino";

import type { McpServerConfig } from "../../agent-sdk-types.js";

export type MuseSessionMcpServer =
  | {
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      transport: "streamableHttp";
      url: string;
      headers?: Record<string, string>;
    };

/**
 * Map Paseo MCP servers to MSP per-session `config.mcpServers`. MSP's server
 * union is closed over stdio and streamable HTTP, so SSE servers are skipped
 * with a warning.
 */
export function mapMuseMcpServers(
  servers: Record<string, McpServerConfig> | undefined,
  logger: Logger,
): Record<string, MuseSessionMcpServer> | undefined {
  if (!servers) {
    return undefined;
  }
  const mapped: Record<string, MuseSessionMcpServer> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (server.type === "stdio") {
      mapped[name] = {
        transport: "stdio",
        command: server.command,
        ...(server.args ? { args: server.args } : {}),
        ...(server.env ? { env: server.env } : {}),
      };
      continue;
    }
    if (server.type === "http") {
      mapped[name] = {
        transport: "streamableHttp",
        url: server.url,
        ...(server.headers ? { headers: server.headers } : {}),
      };
      continue;
    }
    logger.warn(
      { server: name },
      "Skipping SSE MCP server: Muse sessions accept stdio and HTTP only",
    );
  }
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}
