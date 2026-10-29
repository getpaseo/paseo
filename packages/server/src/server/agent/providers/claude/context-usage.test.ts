import type { SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test } from "vitest";

import type { AgentContextUsage } from "../../agent-sdk-types.js";
import { toAgentContextUsage } from "./context-usage.js";

const SKILL_FRONTMATTER = [
  { name: "brainstorming", source: "user", tokens: 55 },
  { name: "tdd", source: "project", tokens: 70 },
] as const;

function sdkContextUsage(
  options: { includeSkills?: boolean; autoCompactThreshold?: number } = {},
): SDKControlGetContextUsageResponse {
  const response: SDKControlGetContextUsageResponse = {
    categories: [
      { name: "System prompt", tokens: 4000, color: "#fff8e7" },
      { name: "Tools", tokens: 2500, color: "#d7f5d7", isDeferred: false },
      { name: "MCP tools", tokens: 800, color: "#d6e6ff", isDeferred: true },
    ],
    totalTokens: 15564,
    maxTokens: 300000,
    rawMaxTokens: 300000,
    percentage: 5,
    model: "claude-sonnet-4-6",
    gridRows: [
      [
        {
          color: "#fff8e7",
          isFilled: true,
          categoryName: "System prompt",
          tokens: 4000,
          percentage: 1,
          squareFullness: 1,
        },
      ],
    ],
    memoryFiles: [
      { path: "/home/user/CLAUDE.md", type: "User", tokens: 120 },
      { path: "/repo/CLAUDE.md", type: "Project", tokens: 340 },
    ],
    mcpTools: [
      { name: "search", serverName: "paseo", tokens: 90, isLoaded: true },
      { name: "browser", serverName: "chrome", tokens: 40 },
    ],
    deferredBuiltinTools: [{ name: "WebSearch", tokens: 7, isLoaded: false }],
    systemTools: [{ name: "Bash", tokens: 8 }],
    systemPromptSections: [{ name: "identity", tokens: 9 }],
    agents: [{ agentType: "Explore", source: "user", tokens: 12 }],
    slashCommands: { totalCommands: 4, includedCommands: 2, tokens: 30 },
    autoCompactThreshold: options.autoCompactThreshold ?? 267000,
    isAutoCompactEnabled: true,
    messageBreakdown: {
      toolCallTokens: 1,
      toolResultTokens: 2,
      attachmentTokens: 3,
      assistantMessageTokens: 4,
      userMessageTokens: 5,
      redirectedContextTokens: 6,
      unattributedTokens: 7,
      toolCallsByType: [{ name: "Read", callTokens: 1, resultTokens: 2 }],
      attachmentsByType: [{ name: "image", tokens: 3 }],
    },
    apiUsage: null,
  };
  if (options.includeSkills !== false) {
    response.skills = {
      totalSkills: 2,
      includedSkills: 2,
      tokens: 125,
      skillFrontmatter: [...SKILL_FRONTMATTER],
    };
  }
  return response;
}

function mappedUsage(
  options: { includeSkills?: boolean; autoCompactThreshold?: number } = {},
): AgentContextUsage {
  const usage: AgentContextUsage = {
    totalTokens: 15564,
    maxTokens: 300000,
    categories: [
      { name: "System prompt", tokens: 4000 },
      { name: "Tools", tokens: 2500 },
      { name: "MCP tools", tokens: 800, deferred: true },
    ],
    memoryFiles: [
      { path: "/home/user/CLAUDE.md", type: "User", tokens: 120 },
      { path: "/repo/CLAUDE.md", type: "Project", tokens: 340 },
    ],
    mcpTools: [
      { name: "search", serverName: "paseo", tokens: 90, loaded: true },
      { name: "browser", serverName: "chrome", tokens: 40 },
    ],
  };
  const autoCompactThreshold = options.autoCompactThreshold ?? 267000;
  if (Number.isFinite(autoCompactThreshold)) {
    usage.autoCompactThreshold = autoCompactThreshold;
  }
  if (options.includeSkills !== false) {
    usage.skills = [...SKILL_FRONTMATTER];
  }
  return usage;
}

describe("toAgentContextUsage", () => {
  test("maps the SDK breakdown and drops display-only fields", () => {
    expect(toAgentContextUsage(sdkContextUsage())).toEqual(mappedUsage());
  });

  test("omits skills when the SDK response has none", () => {
    const usage = toAgentContextUsage(sdkContextUsage({ includeSkills: false }));

    expect(usage).toEqual(mappedUsage({ includeSkills: false }));
    expect(usage).not.toHaveProperty("skills");
  });

  test("omits a non-finite auto compact threshold", () => {
    const usage = toAgentContextUsage(
      sdkContextUsage({ includeSkills: false, autoCompactThreshold: Number.POSITIVE_INFINITY }),
    );

    expect(usage).toEqual(
      mappedUsage({ includeSkills: false, autoCompactThreshold: Number.POSITIVE_INFINITY }),
    );
    expect(usage).not.toHaveProperty("autoCompactThreshold");
  });
});
