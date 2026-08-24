import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import { selectRetainedHistoryRootAgents } from "./sidebar-retained-history-agents";

function agent(input: {
  id: string;
  workspaceId: string;
  parentAgentId?: string | null;
  status?: Agent["status"];
  archivedAt?: Date | null;
  lastActivityAt?: string;
}): Agent {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    parentAgentId: input.parentAgentId ?? null,
    status: input.status ?? "idle",
    archivedAt: input.archivedAt ?? null,
    lastActivityAt: new Date(input.lastActivityAt ?? "2026-08-24T10:00:00.000Z"),
  } as Agent;
}

describe("retained-history agent links", () => {
  it("keeps live root agents reachable and excludes subagents, archives, and other workspaces", () => {
    const firstCatalogAgent = agent({
      id: "catalog-search-a",
      workspaceId: "wks_orphan",
      status: "running",
    });
    const secondCatalogAgent = agent({
      id: "catalog-search-b",
      workspaceId: "wks_orphan",
      lastActivityAt: "2026-08-24T11:00:00.000Z",
    });
    const child = agent({
      id: "child",
      workspaceId: "wks_orphan",
      parentAgentId: firstCatalogAgent.id,
    });
    const archived = agent({
      id: "archived",
      workspaceId: "wks_orphan",
      archivedAt: new Date("2026-08-23T10:00:00.000Z"),
    });
    const other = agent({ id: "other", workspaceId: "wks_other", status: "running" });
    const agents = new Map(
      [firstCatalogAgent, secondCatalogAgent, child, archived, other].map((value) => [
        value.id,
        value,
      ]),
    );

    expect(selectRetainedHistoryRootAgents(agents, " wks_orphan ").map((item) => item.id)).toEqual([
      "catalog-search-a",
      "catalog-search-b",
    ]);
  });

  it("treats an agent whose parent belongs to another workspace as a workspace root", () => {
    const parent = agent({ id: "parent", workspaceId: "wks_other" });
    const movedRoot = agent({
      id: "moved-root",
      workspaceId: "wks_orphan",
      parentAgentId: parent.id,
    });
    const agents = new Map([
      [parent.id, parent],
      [movedRoot.id, movedRoot],
    ]);

    expect(selectRetainedHistoryRootAgents(agents, "wks_orphan").map((item) => item.id)).toEqual([
      "moved-root",
    ]);
  });
});
