import { describe, expect, it } from "vitest";
import type { AgentHistoryEntry } from "@getpaseo/protocol/messages";
import { originGroup, summarizeHistory } from "./session-history";

function entry(
  input: Partial<AgentHistoryEntry> & Pick<AgentHistoryEntry, "agentId">,
): AgentHistoryEntry {
  return {
    state: "active",
    title: null,
    origin: null,
    parentAgentId: null,
    provider: "claude",
    model: null,
    cwd: "/repo",
    workspaceId: null,
    internal: false,
    createdAt: "2026-09-29T10:00:00.000Z",
    lastActivityAt: null,
    archivedAt: null,
    deletedAt: null,
    summary: null,
    usage: null,
    labels: {},
    ...input,
  };
}

const usage = (tokens: number, cost: number) => ({
  turns: 1,
  inputTokens: tokens,
  cachedInputTokens: tokens,
  outputTokens: 0,
  totalCostUsd: cost,
});

describe("session history", () => {
  it("maps every origin the daemon writes to a group", () => {
    expect(originGroup("user:cli")).toBe("user");
    expect(originGroup("schedule:59e54f02")).toBe("schedule");
    expect(originGroup("paperclip:Boss")).toBe("paperclip");
    expect(originGroup("agent:abc")).toBe("agent");
    expect(originGroup("systemd:paseo-origin-test.service")).toBe("script");
    expect(originGroup("process:tsx")).toBe("script");
    expect(originGroup("internal")).toBe("internal");
    expect(originGroup(null)).toBe("unknown");
  });

  it("sums sessions, deletions, tokens and cost per group, biggest spender first", () => {
    const summaries = summarizeHistory([
      entry({ agentId: "a", origin: "user", usage: usage(100, 0.5) }),
      entry({ agentId: "b", origin: "paperclip:Boss", usage: usage(1000, 2) }),
      entry({ agentId: "c", origin: "paperclip:Dev", state: "deleted", usage: usage(500, 1) }),
      entry({ agentId: "d", origin: null }),
    ]);
    expect(summaries.map((s) => [s.group, s.sessions, s.deleted, s.tokens, s.costUsd])).toEqual([
      ["paperclip", 2, 1, 3000, 3],
      ["user", 1, 0, 200, 0.5],
      ["unknown", 1, 0, 0, 0],
    ]);
  });
});
