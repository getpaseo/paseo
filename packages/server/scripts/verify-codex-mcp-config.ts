// Quick script to verify buildCodexMcpConfig includes MCP servers

import { buildPaseoDaemonConfigFromEnv } from "../src/server/config.js";

const config = buildPaseoDaemonConfigFromEnv();

console.log("=== agentControlMcp config ===");
console.log(JSON.stringify(config.agentControlMcp, null, 2));

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

console.log("\n=== Built MCP servers config ===");
console.log(JSON.stringify(mcpServers, null, 2));
