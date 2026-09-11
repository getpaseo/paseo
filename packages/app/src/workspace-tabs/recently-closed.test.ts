import { describe, expect, it } from "vitest";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { selectRecentlyClosedAgents } from "@/workspace-tabs/recently-closed";

function makeAgent(input: {
  id: string;
  workspaceId?: string;
  archivedAt?: Date | null;
  lastActivityAt?: Date;
}): AggregatedAgent {
  const lastActivityAt = input.lastActivityAt ?? new Date("2026-03-04T00:00:00.000Z");
  return {
    id: input.id,
    serverId: "srv",
    serverLabel: "srv",
    title: input.id,
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    lastActivityAt,
    cwd: "/repo",
    workspaceId: input.workspaceId,
    provider: "codex",
    pendingPermissionCount: 0,
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: input.archivedAt ?? null,
    createdAt: lastActivityAt,
    labels: {},
  };
}

const WORKSPACE_ID = "ws-1";

describe("selectRecentlyClosedAgents", () => {
  it("filters other workspaces", () => {
    const matching = makeAgent({
      id: "matching",
      workspaceId: WORKSPACE_ID,
      archivedAt: new Date("2026-03-04T00:02:00.000Z"),
    });
    const otherWorkspace = makeAgent({
      id: "other-workspace",
      workspaceId: "ws-other",
      archivedAt: new Date("2026-03-04T00:03:00.000Z"),
    });

    expect(
      selectRecentlyClosedAgents([matching, otherWorkspace], {
        workspaceId: WORKSPACE_ID,
        limit: 20,
      }).map((agent) => agent.id),
    ).toEqual(["matching"]);
  });

  it("drops unarchived rows", () => {
    const archived = makeAgent({
      id: "archived",
      workspaceId: WORKSPACE_ID,
      archivedAt: new Date("2026-03-04T00:02:00.000Z"),
    });
    const active = makeAgent({
      id: "active",
      workspaceId: WORKSPACE_ID,
    });

    expect(
      selectRecentlyClosedAgents([archived, active], {
        workspaceId: WORKSPACE_ID,
        limit: 20,
      }).map((agent) => agent.id),
    ).toEqual(["archived"]);
  });

  it("orders by archivedAt not lastActivityAt", () => {
    const olderArchive = makeAgent({
      id: "older-archive",
      workspaceId: WORKSPACE_ID,
      archivedAt: new Date("2026-03-04T00:01:00.000Z"),
      lastActivityAt: new Date("2026-03-04T00:10:00.000Z"),
    });
    const newerArchive = makeAgent({
      id: "newer-archive",
      workspaceId: WORKSPACE_ID,
      archivedAt: new Date("2026-03-04T00:05:00.000Z"),
      lastActivityAt: new Date("2026-03-04T00:02:00.000Z"),
    });

    expect(
      selectRecentlyClosedAgents([olderArchive, newerArchive], {
        workspaceId: WORKSPACE_ID,
        limit: 20,
      }).map((agent) => agent.id),
    ).toEqual(["newer-archive", "older-archive"]);
  });

  it("respects the limit", () => {
    const agents = [
      makeAgent({
        id: "first",
        workspaceId: WORKSPACE_ID,
        archivedAt: new Date("2026-03-04T00:03:00.000Z"),
      }),
      makeAgent({
        id: "second",
        workspaceId: WORKSPACE_ID,
        archivedAt: new Date("2026-03-04T00:02:00.000Z"),
      }),
      makeAgent({
        id: "third",
        workspaceId: WORKSPACE_ID,
        archivedAt: new Date("2026-03-04T00:01:00.000Z"),
      }),
    ];

    expect(
      selectRecentlyClosedAgents(agents, { workspaceId: WORKSPACE_ID, limit: 2 }).map(
        (agent) => agent.id,
      ),
    ).toEqual(["first", "second"]);
  });
});
