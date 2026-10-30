import type { SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";

import type {
  AgentContextUsage,
  AgentContextUsageCategory,
  AgentContextUsageMcpTool,
  AgentContextUsageMemoryFile,
  AgentContextUsageSkill,
} from "../../agent-sdk-types.js";

type SdkContextUsageCategory = SDKControlGetContextUsageResponse["categories"][number];
type SdkContextUsageMcpTool = SDKControlGetContextUsageResponse["mcpTools"][number];
type SdkContextUsageMemoryFile = SDKControlGetContextUsageResponse["memoryFiles"][number];
type SdkContextUsageSkill = NonNullable<
  SDKControlGetContextUsageResponse["skills"]
>["skillFrontmatter"][number];

function mapCategory(category: SdkContextUsageCategory): AgentContextUsageCategory {
  if (category.isDeferred === true) {
    return { name: category.name, tokens: category.tokens, deferred: true };
  }
  return { name: category.name, tokens: category.tokens };
}

function mapMemoryFile(file: SdkContextUsageMemoryFile): AgentContextUsageMemoryFile {
  return { path: file.path, type: file.type, tokens: file.tokens };
}

function mapMcpTool(tool: SdkContextUsageMcpTool): AgentContextUsageMcpTool {
  if (tool.isLoaded === undefined) {
    return { name: tool.name, serverName: tool.serverName, tokens: tool.tokens };
  }
  return {
    name: tool.name,
    serverName: tool.serverName,
    tokens: tool.tokens,
    loaded: tool.isLoaded,
  };
}

function mapSkill(skill: SdkContextUsageSkill): AgentContextUsageSkill {
  return { name: skill.name, source: skill.source, tokens: skill.tokens };
}

export function toAgentContextUsage(
  response: SDKControlGetContextUsageResponse,
): AgentContextUsage {
  const usage: AgentContextUsage = {
    totalTokens: response.totalTokens,
    maxTokens: response.maxTokens,
    categories: response.categories.map(mapCategory),
    memoryFiles: response.memoryFiles.map(mapMemoryFile),
    mcpTools: response.mcpTools.map(mapMcpTool),
  };
  const autoCompactThreshold = response.autoCompactThreshold;
  if (typeof autoCompactThreshold === "number" && Number.isFinite(autoCompactThreshold)) {
    usage.autoCompactThreshold = autoCompactThreshold;
  }
  const skills = response.skills?.skillFrontmatter.map(mapSkill);
  if (skills) {
    usage.skills = skills;
  }
  return usage;
}
