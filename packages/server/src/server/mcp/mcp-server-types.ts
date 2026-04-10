import type { McpServerConfig } from "../agent/agent-sdk-types.js";
export type { McpServerConfig } from "../agent/agent-sdk-types.js";

/**
 * MCP server record persisted to disk.
 */
export interface McpServerRecord {
  id: string;
  name: string;
  type: "stdio" | "http" | "sse";
  config: McpServerConfig;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  tags?: string[];
  description?: string;
}

/**
 * Store structure for MCP servers file.
 */
export interface McpServersStoreData {
  servers: McpServerRecord[];
}

/**
 * Input for creating a new MCP server.
 */
export interface CreateMcpServerInput {
  name: string;
  type: "stdio" | "http" | "sse";
  config: McpServerConfig;
  enabled?: boolean;
  tags?: string[];
  description?: string;
}

/**
 * Updates for an existing MCP server.
 */
export interface UpdateMcpServerInput {
  name?: string;
  type?: "stdio" | "http" | "sse";
  config?: McpServerConfig;
  enabled?: boolean;
  tags?: string[];
  description?: string;
}
