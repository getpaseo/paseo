import { describe, expect, it } from "vitest";
import { deriveRemoteProjectKey, groupAgents } from "./agent-grouping";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";

function makeAgent(overrides: Partial<AggregatedAgent> = {}): AggregatedAgent {
  const now = new Date();
  return {
    id: overrides.id ?? "a1",
    serverId: overrides.serverId ?? "s1",
    serverLabel: (overrides as any).serverLabel ?? "server",
    title: overrides.title ?? null,
    status: overrides.status ?? ("running" as AggregatedAgent["status"]),
    lastActivityAt: overrides.lastActivityAt ?? now,
    cwd: overrides.cwd ?? "/tmp/repo",
    provider: overrides.provider ?? ("openai" as any),
    requiresAttention: overrides.requiresAttention ?? false,
    attentionReason: overrides.attentionReason ?? null,
    attentionTimestamp: overrides.attentionTimestamp ?? null,
  } as AggregatedAgent;
}

describe("deriveRemoteProjectKey", () => {
  it("normalizes GitHub SSH and HTTPS to the same key", () => {
    const ssh = "git@github.com:owner/repo.git";
    const https = "https://github.com/owner/repo";
    expect(deriveRemoteProjectKey(ssh)).toBe("remote:github.com/owner/repo");
    expect(deriveRemoteProjectKey(https)).toBe("remote:github.com/owner/repo");
  });

  it("includes host for non-GitHub remotes", () => {
    const gitlab = "git@gitlab.example.com:group/repo.git";
    expect(deriveRemoteProjectKey(gitlab)).toBe(
      "remote:gitlab.example.com/group/repo"
    );
  });
});

describe("groupAgents", () => {
  it("groups active agents by remote URL when available", () => {
    const agents = [
      makeAgent({ id: "a1", cwd: "/Users/me/dev/paseo" }),
      makeAgent({ id: "a2", cwd: "/Users/me/dev/paseo-fix/worktree" }),
    ];

    const { activeGroups } = groupAgents(agents, {
      getRemoteUrl: () => "git@github.com:moboudra/paseo.git",
    });

    expect(activeGroups).toHaveLength(1);
    expect(activeGroups[0]?.agents.map((a) => a.id).sort()).toEqual([
      "a1",
      "a2",
    ]);
  });

  it("falls back to cwd grouping when remote URL is unavailable", () => {
    const agents = [
      makeAgent({ id: "a1", cwd: "/Users/me/dev/paseo" }),
      makeAgent({ id: "a2", cwd: "/Users/me/dev/paseo-fix/worktree" }),
    ];

    const { activeGroups } = groupAgents(agents, {
      getRemoteUrl: () => null,
    });

    expect(activeGroups).toHaveLength(2);
  });
});
