import { describe, expect, it, vi } from "vitest";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import {
  areAllArchivedAgentsSelected,
  deleteSelectedArchivedAgents,
  resolveSelectedArchivedAgents,
  toggleAgentSelectionKey,
} from "./sessions-manage";

function agent(overrides: Pick<AggregatedAgent, "id"> & Partial<AggregatedAgent>): AggregatedAgent {
  const { id, ...rest } = overrides;
  return {
    serverId: "host-a",
    serverLabel: "Host A",
    id,
    provider: "claude",
    status: "closed",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
    cwd: "/repo",
    workspaceId: undefined,
    title: id,
    labels: {},
    archivedAt: null,
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    projectPlacement: null,
    pendingPermissionCount: 0,
    ...rest,
  };
}

describe("sessions-manage helpers", () => {
  it("toggles selection keys", () => {
    const target = agent({ id: "1", archivedAt: new Date() });
    const once = toggleAgentSelectionKey(new Set(), target);
    expect([...once]).toEqual(["host-a:1"]);
    expect([...toggleAgentSelectionKey(once, target)]).toEqual([]);
  });

  it("resolves only selected agents", () => {
    const agents = [
      agent({ id: "1", archivedAt: new Date() }),
      agent({ id: "2", archivedAt: new Date() }),
    ];
    expect(
      resolveSelectedArchivedAgents(agents, new Set(["host-a:2"])).map((item) => item.id),
    ).toEqual(["2"]);
  });

  it("detects when every archived agent is selected", () => {
    const agents = [
      agent({ id: "1", archivedAt: new Date() }),
      agent({ id: "2", archivedAt: null }),
      agent({ id: "3", archivedAt: new Date() }),
    ];
    expect(areAllArchivedAgentsSelected(agents, new Set(["host-a:1"]))).toBe(false);
    expect(areAllArchivedAgentsSelected(agents, new Set(["host-a:1", "host-a:3"]))).toBe(true);
  });

  it("deletes each selected archived agent", async () => {
    const deleteAgent = vi.fn(async () => undefined);
    const agents = [
      agent({ id: "1", archivedAt: new Date() }),
      agent({ id: "2", archivedAt: new Date() }),
      agent({ id: "3", archivedAt: null }),
    ];
    const count = await deleteSelectedArchivedAgents({
      agents,
      selectedKeys: new Set(["host-a:1", "host-a:2"]),
      deleteAgent,
    });
    expect(count).toBe(2);
    expect(deleteAgent).toHaveBeenCalledTimes(2);
  });
});
