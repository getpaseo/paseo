import { describe, expect, it } from "vitest";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { filterAgentsBySearchQuery } from "./session-list-search";

function agent(overrides: Partial<AggregatedAgent> & Pick<AggregatedAgent, "id">): AggregatedAgent {
  return {
    id: overrides.id,
    serverId: overrides.serverId ?? "local",
    serverLabel: overrides.serverLabel ?? "Local",
    title: overrides.title ?? null,
    status: overrides.status ?? "idle",
    lastActivityAt: overrides.lastActivityAt ?? new Date("2026-07-30T00:00:00.000Z"),
    cwd: overrides.cwd ?? "/tmp/repo",
    workspaceId: overrides.workspaceId ?? "ws-1",
    provider: overrides.provider ?? "claude",
    pendingPermissionCount: overrides.pendingPermissionCount ?? 0,
    requiresAttention: overrides.requiresAttention ?? false,
    attentionReason: overrides.attentionReason ?? null,
    attentionTimestamp: overrides.attentionTimestamp ?? null,
    archivedAt: overrides.archivedAt ?? null,
    createdAt: overrides.createdAt ?? new Date("2026-07-30T00:00:00.000Z"),
    labels: overrides.labels ?? {},
    projectPlacement: overrides.projectPlacement,
  };
}

describe("filterAgentsBySearchQuery", () => {
  const agents = [
    agent({ id: "1", title: "Fix auth bug", provider: "claude", cwd: "/tmp/auth" }),
    agent({ id: "2", title: "Ship release", provider: "codex", serverLabel: "Laptop" }),
  ];

  it("returns all agents for empty query", () => {
    expect(filterAgentsBySearchQuery(agents, "   ").map((entry) => entry.id)).toEqual(["1", "2"]);
  });

  it("filters by title, provider, path, and host label", () => {
    expect(filterAgentsBySearchQuery(agents, "auth").map((entry) => entry.id)).toEqual(["1"]);
    expect(filterAgentsBySearchQuery(agents, "codex").map((entry) => entry.id)).toEqual(["2"]);
    expect(filterAgentsBySearchQuery(agents, "laptop").map((entry) => entry.id)).toEqual(["2"]);
  });
});
