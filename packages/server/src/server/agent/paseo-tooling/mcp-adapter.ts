import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  createPaseoToolRegistry,
  type AgentMcpServerOptions,
  type PaseoToolingRegistryOptions,
} from "./registry.js";

export async function createAgentMcpServer(options: AgentMcpServerOptions): Promise<McpServer> {
  const server = new McpServer({
    name: "agent-mcp",
    version: "2.0.0",
  });
  const registry = createPaseoToolRegistry(options);
  for (const tool of registry.listTools()) {
    server.registerTool(tool.name, tool.config, tool.handler);
  }
  return server;
}

export type { AgentMcpServerOptions, PaseoToolingRegistryOptions };
