import { describe, expect, it } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { buildFlatItems } from "./agent-list-grouping";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";

function makeAgent(
  id: string,
  serverId: string,
  overrides: Partial<AggregatedAgent> = {},
): AggregatedAgent {
  return {
    id,
    serverId,
    serverLabel: "local",
    title: null,
    status: "idle",
    lastActivityAt: new Date("2025-01-10T12:00:00Z"),
    cwd: "/",
    provider: "claude",
    createdAt: new Date("2025-01-10T12:00:00Z"),
    labels: {},
    ...overrides,
  } as AggregatedAgent;
}

describe("buildFlatItems", () => {
  it("parent with two children is collapsed by default — shows child count, children hidden", () => {
    const parent = makeAgent("parent-1", "server-1");
    const child1 = makeAgent("child-1", "server-1", {
      labels: { [PARENT_AGENT_ID_LABEL]: "parent-1" },
      createdAt: new Date("2025-01-10T12:01:00Z"),
    });
    const child2 = makeAgent("child-2", "server-1", {
      labels: { [PARENT_AGENT_ID_LABEL]: "parent-1" },
      createdAt: new Date("2025-01-10T12:02:00Z"),
    });

    const items = buildFlatItems([parent, child1, child2], new Set());
    const agentItems = items.filter((i) => i.type === "agent");

    // Only the parent row is visible (children hidden while collapsed)
    expect(agentItems).toHaveLength(1);

    const parentItem = agentItems[0];
    if (parentItem.type !== "agent") throw new Error("expected agent item");
    expect(parentItem.agent.id).toBe("parent-1");
    expect(parentItem.hasChildren).toBe(true);
    expect(parentItem.expanded).toBe(false);
    expect(parentItem.childCount).toBe(2);
    expect(parentItem.depth).toBe(0);
  });

  it("expanding a parent shows its two children in createdAt asc order immediately after", () => {
    const parent = makeAgent("parent-1", "server-1");
    // child2 has an earlier createdAt than child1 to verify ascending sort
    const child1 = makeAgent("child-1", "server-1", {
      labels: { [PARENT_AGENT_ID_LABEL]: "parent-1" },
      createdAt: new Date("2025-01-10T12:02:00Z"),
    });
    const child2 = makeAgent("child-2", "server-1", {
      labels: { [PARENT_AGENT_ID_LABEL]: "parent-1" },
      createdAt: new Date("2025-01-10T12:01:00Z"),
    });

    const expandedKey = "server-1:parent-1";
    const items = buildFlatItems([parent, child1, child2], new Set([expandedKey]));
    const agentItems = items.filter((i) => i.type === "agent");

    // Parent + 2 children
    expect(agentItems).toHaveLength(3);

    const [parentRow, firstChild, secondChild] = agentItems;

    if (parentRow.type !== "agent") throw new Error("expected agent item");
    expect(parentRow.agent.id).toBe("parent-1");
    expect(parentRow.expanded).toBe(true);
    expect(parentRow.depth).toBe(0);

    if (firstChild.type !== "agent") throw new Error("expected agent item");
    // child2 has earlier createdAt so it sorts first
    expect(firstChild.agent.id).toBe("child-2");
    expect(firstChild.depth).toBe(1);
    expect(firstChild.hasChildren).toBe(false);

    if (secondChild.type !== "agent") throw new Error("expected agent item");
    expect(secondChild.agent.id).toBe("child-1");
    expect(secondChild.depth).toBe(1);
  });

  it("orphan child (parent id not present in agents list) renders as a top-level row", () => {
    const orphan = makeAgent("orphan-1", "server-1", {
      labels: { [PARENT_AGENT_ID_LABEL]: "missing-parent" },
    });

    const items = buildFlatItems([orphan], new Set());
    const agentItems = items.filter((i) => i.type === "agent");

    expect(agentItems).toHaveLength(1);

    const item = agentItems[0];
    if (item.type !== "agent") throw new Error("expected agent item");
    expect(item.agent.id).toBe("orphan-1");
    expect(item.depth).toBe(0);
    expect(item.hasChildren).toBe(false);
    expect(item.childCount).toBe(0);
  });
});
