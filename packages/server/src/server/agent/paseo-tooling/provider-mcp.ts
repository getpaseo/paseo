import type { AgentLaunchContext, AgentSessionConfig } from "../agent-sdk-types.js";

const PASEO_MCP_SERVER_NAME = "paseo";

export function withPaseoToolingMcpServer(
  config: AgentSessionConfig,
  launchContext: AgentLaunchContext | undefined,
): AgentSessionConfig {
  const mcpUrl = launchContext?.paseoTooling?.mcpUrl;
  if (!mcpUrl || config.mcpServers?.[PASEO_MCP_SERVER_NAME]) {
    return config;
  }

  return {
    ...config,
    mcpServers: {
      [PASEO_MCP_SERVER_NAME]: {
        type: "http",
        url: mcpUrl,
      },
      ...config.mcpServers,
    },
  };
}
