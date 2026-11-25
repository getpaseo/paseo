import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSessionConfig, McpServerConfig } from "./agent-sdk-types.js";

export const PASEO_MCP_SERVER_NAME = "paseo";
const PASEO_MCP_PATHNAME = "/mcp/agents";
const PASEO_MCP_BRIDGE_NAME = "mcp-unix-bridge-cli";

export type AgentMcpEndpoint = { type: "http"; url: string } | { type: "socket"; path: string };

interface RuntimePaseoMcpParams {
  config: AgentSessionConfig;
  agentId: string;
  mcpEndpoint: AgentMcpEndpoint | null;
  /** Capability token for the daemon's Agent MCP endpoint. */
  mcpAuthToken: string | null;
}

function createSocketMcpServer(params: RuntimePaseoMcpParams, socketPath: string): McpServerConfig {
  const source = import.meta.url.endsWith(".ts");
  const entry = fileURLToPath(
    new URL(`./${PASEO_MCP_BRIDGE_NAME}.${source ? "ts" : "mjs"}`, import.meta.url),
  );
  // Electron cannot use an ES module inside ASAR as its Node entrypoint.
  // The standalone bundle is unpacked by electron-builder.
  const entryPath = entry.replace(/([\\/][^\\/]+\.asar)[\\/]/, "$1.unpacked/");
  return {
    type: "stdio",
    command: process.execPath,
    args: [
      ...(source ? ["--import", import.meta.resolve("tsx")] : []),
      entryPath,
      "--socket",
      socketPath,
      "--agent-id",
      params.agentId,
    ],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      ...(params.mcpAuthToken ? { PASEO_AGENT_MCP_TOKEN: params.mcpAuthToken } : {}),
    },
  };
}

export function stripInternalPaseoMcpServer(config: AgentSessionConfig): AgentSessionConfig {
  const mcpServers = config.mcpServers;
  if (!mcpServers) {
    return config;
  }

  const paseoServer = mcpServers[PASEO_MCP_SERVER_NAME];
  if (!paseoServer || !isInternalPaseoMcpServer(paseoServer)) {
    return config;
  }

  const nextMcpServers = { ...mcpServers };
  delete nextMcpServers[PASEO_MCP_SERVER_NAME];

  const next = { ...config };
  if (Object.keys(nextMcpServers).length > 0) {
    next.mcpServers = nextMcpServers;
  } else {
    delete next.mcpServers;
  }
  return next;
}

export function withRuntimePaseoMcpServer(params: RuntimePaseoMcpParams): AgentSessionConfig {
  const storedConfig = stripInternalPaseoMcpServer(params.config);
  if (!params.mcpEndpoint || storedConfig.mcpServers?.[PASEO_MCP_SERVER_NAME]) {
    return storedConfig;
  }

  return {
    ...storedConfig,
    mcpServers: {
      [PASEO_MCP_SERVER_NAME]:
        params.mcpEndpoint.type === "socket"
          ? createSocketMcpServer(params, params.mcpEndpoint.path)
          : {
              type: "http",
              url: `${params.mcpEndpoint.url}?callerAgentId=${encodeURIComponent(params.agentId)}`,
              ...(params.mcpAuthToken
                ? { headers: { Authorization: `Bearer ${params.mcpAuthToken}` } }
                : {}),
            },
      ...storedConfig.mcpServers,
    },
  };
}

function isInternalPaseoMcpServer(config: McpServerConfig): boolean {
  if (config.type === "stdio") {
    return (
      config.args?.some(
        (arg) =>
          path.basename(arg) === `${PASEO_MCP_BRIDGE_NAME}.ts` ||
          path.basename(arg) === `${PASEO_MCP_BRIDGE_NAME}.mjs`,
      ) ?? false
    );
  }
  if (config.type !== "http" && config.type !== "sse") {
    return false;
  }

  try {
    return new URL(config.url).pathname === PASEO_MCP_PATHNAME;
  } catch {
    return false;
  }
}
