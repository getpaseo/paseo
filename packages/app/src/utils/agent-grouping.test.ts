import { describe, expect, it } from "vitest";
import { deriveProjectDisplayName, deriveRemoteProjectKey, groupAgents } from "./agent-grouping";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";

function makeAgent(overrides: Partial<AggregatedAgent> = {}): AggregatedAgent {
  const now = new Date();
  return {
    id: overrides.id ?? "a1",
    serverId: overrides.serverId ?? "s1",
    serverLabel: (overrides as { serverLabel?: string }).serverLabel ?? "server",
    title: overrides.title ?? null,
    status: overrides.status ?? ("running" as AggregatedAgent["status"]),
    turn:
      overrides.turn ??
      ({
        phase: "open",
        turnId: null,
        startedAt: null,
        cancellationRequestId: null,
      } as const),
    lastActivityAt: overrides.lastActivityAt ?? now,
    cwd: overrides.cwd ?? "/tmp/repo",
    provider: overrides.provider ?? ("openai" as AggregatedAgent["provider"]),
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
    expect(deriveRemoteProjectKey(gitlab)).toBe("remote:gitlab.example.com/group/repo");
  });
});

describe("deriveProjectDisplayName", () => {
  it("shows owner/repo for GitHub remote keys", () => {
    expect(
      deriveProjectDisplayName({
        projectKey: "remote:github.com/getpaseo/paseo",
        projectName: "paseo",
      }),
    ).toBe("getpaseo/paseo");
  });

  it("shows remote path for non-GitHub remote keys", () => {
    expect(
      deriveProjectDisplayName({
        projectKey: "remote:gitlab.example.com/group/repo",
        projectName: "repo",
      }),
    ).toBe("group/repo");
  });

  it("falls back to projectName for local keys", () => {
    expect(
      deriveProjectDisplayName({
        projectKey: "/Users/me/dev/paseo",
        projectName: "paseo",
      }),
    ).toBe("paseo");
  });
});

describe("groupAgents", () => {
  it("uses turn liveness instead of protocol status for active grouping", () => {
    const old = new Date("2020-01-01T00:00:00.000Z");
    const open = makeAgent({ id: "open", status: "idle", lastActivityAt: old });
    const idle = makeAgent({
      id: "idle",
      status: "running",
      lastActivityAt: old,
      turn: { phase: "idle", cancellationRequestId: null },
    });

    const grouped = groupAgents([open, idle]);

    const activeIds = grouped.activeGroups
      .flatMap((group) => group.agents)
      .map((agent) => agent.id);
    const inactiveIds = grouped.inactiveGroups
      .flatMap((group) => group.agents)
      .map((agent) => agent.id);
    expect(activeIds).toEqual(["open"]);
    expect(inactiveIds).toEqual(["idle"]);
  });

  it("groups active agents by remote URL when available", () => {
    const agents = [
      makeAgent({ id: "a1", cwd: "/Users/me/dev/paseo" }),
      makeAgent({ id: "a2", cwd: "/Users/me/dev/paseo-fix/worktree" }),
    ];

    const { activeGroups } = groupAgents(agents, {
      getRemoteUrl: () => "git@github.com:getpaseo/paseo.git",
    });

    expect(activeGroups).toHaveLength(1);
    expect(activeGroups[0]?.agents.map((a) => a.id).sort()).toEqual(["a1", "a2"]);
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
