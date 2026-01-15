// Quick script to verify buildCodexMcpConfig includes MCP servers

import { buildPaseoDaemonConfigFromEnv } from "../src/server/config.js";

const config = buildPaseoDaemonConfigFromEnv();

process.stdout.write("=== agentControlMcp config ===\n");
process.stdout.write(JSON.stringify(config.agentControlMcp, null, 2) + "\n");

// Simulate what buildCodexMcpConfig does
const mcpServers: Record<string, unknown> = {};

if (config.agentControlMcp) {
  const agentControlUrl = config.agentControlMcp.url;
  mcpServers["agent-control"] = {
    url: agentControlUrl,
    ...(config.agentControlMcp.headers ? { http_headers: config.agentControlMcp.headers } : {}),
  };
}

mcpServers["playwright"] = {
  command: "npx",
  args: ["@playwright/mcp", "--headless", "--isolated"],
};

process.stdout.write("\n=== Built MCP servers config ===\n");
process.stdout.write(JSON.stringify(mcpServers, null, 2) + "\n");
