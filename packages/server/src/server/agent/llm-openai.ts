import type { ToolSet } from "ai";

/**
 * Get all tools for voice LLM
 * @param agentTools - Agent control tools from MCP
 */
export function getAllTools(agentTools?: ToolSet): ToolSet {
  return agentTools ?? {};
}
