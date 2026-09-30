import { describe, expect, it } from "vitest";
import type { AgentHistoryEntry } from "@getpaseo/protocol/messages";
import { aggregateProviderTokens, formatTokenCount } from "./token-usage-section";

const SINCE = Date.parse("2026-09-24T00:00:00.000Z");

function entry(overrides: Partial<AgentHistoryEntry>): AgentHistoryEntry {
  return {
    agentId: "a",
    state: "active",
    title: null,
    origin: null,
    parentAgentId: null,
    provider: "claude",
    model: null,
    cwd: "/repo",
    workspaceId: null,
    internal: false,
    createdAt: "2026-09-29T08:00:00.000Z",
    lastActivityAt: "2026-09-29T09:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    summary: null,
    usage: {
      turns: 2,
      inputTokens: 1000,
      cachedInputTokens: 500,
      outputTokens: 200,
      totalCostUsd: 0.5,
    },
    ...overrides,
  } as AgentHistoryEntry;
}

describe("aggregateProviderTokens", () => {
  it("sums sessions active in the window per provider, heaviest first", () => {
    const rows = aggregateProviderTokens(
      [
        entry({ agentId: "1" }),
        entry({ agentId: "2" }),
        entry({ agentId: "3", provider: "codex-plus" }),
        entry({ agentId: "old", lastActivityAt: "2026-09-20T09:00:00.000Z" }),
        entry({ agentId: "none", usage: null }),
      ],
      SINCE,
    );
    expect(rows).toEqual([
      {
        provider: "claude",
        sessions: 2,
        turns: 4,
        inputTokens: 3000,
        outputTokens: 400,
        costUsd: 1,
      },
      {
        provider: "codex-plus",
        sessions: 1,
        turns: 2,
        inputTokens: 1500,
        outputTokens: 200,
        costUsd: 0.5,
      },
    ]);
  });

  it("formats counts compactly", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(3410)).toBe("3.4k");
    expect(formatTokenCount(48_700)).toBe("49k");
    expect(formatTokenCount(2_350_000)).toBe("2.4M");
  });
});
