import { describe, expect, it } from "vitest";
import {
  buildSubtreePendingPermissionCounts,
  getParentAgentId,
  isAgentInSubtree,
} from "./agent-hierarchy";

function makeAgent(input: {
  id: string;
  parentAgentId?: string;
  pendingPermissionCount?: number;
}): {
  id: string;
  labels: Record<string, string>;
  pendingPermissions: { id: string }[];
} {
  return {
    id: input.id,
    labels: input.parentAgentId ? { "paseo.parent-agent-id": input.parentAgentId } : {},
    pendingPermissions: Array.from({ length: input.pendingPermissionCount ?? 0 }, (_, index) => ({
      id: `${input.id}-request-${index}`,
    })),
  };
}

describe("agent-hierarchy", () => {
  it("reads parent agent ids from labels", () => {
    expect(getParentAgentId(makeAgent({ id: "child", parentAgentId: "parent" }))).toBe("parent");
    expect(getParentAgentId(makeAgent({ id: "root" }))).toBeNull();
  });

  it("treats descendants as part of the parent subtree", () => {
    const agents = new Map([
      ["root", makeAgent({ id: "root" })],
      ["child", makeAgent({ id: "child", parentAgentId: "root" })],
      ["grandchild", makeAgent({ id: "grandchild", parentAgentId: "child" })],
      ["other", makeAgent({ id: "other" })],
    ]);

    expect(isAgentInSubtree(agents, "root", "root")).toBe(true);
    expect(isAgentInSubtree(agents, "child", "root")).toBe(true);
    expect(isAgentInSubtree(agents, "grandchild", "root")).toBe(true);
    expect(isAgentInSubtree(agents, "other", "root")).toBe(false);
  });

  it("aggregates pending permission counts across descendants", () => {
    const counts = buildSubtreePendingPermissionCounts([
      makeAgent({ id: "root", pendingPermissionCount: 1 }),
      makeAgent({ id: "child", parentAgentId: "root", pendingPermissionCount: 2 }),
      makeAgent({ id: "grandchild", parentAgentId: "child", pendingPermissionCount: 3 }),
      makeAgent({ id: "other", pendingPermissionCount: 4 }),
    ]);

    expect(counts.get("root")).toBe(6);
    expect(counts.get("child")).toBe(5);
    expect(counts.get("grandchild")).toBe(3);
    expect(counts.get("other")).toBe(4);
  });

  it("stops walking when parent labels form a cycle", () => {
    const counts = buildSubtreePendingPermissionCounts([
      makeAgent({ id: "a", parentAgentId: "b", pendingPermissionCount: 1 }),
      makeAgent({ id: "b", parentAgentId: "a", pendingPermissionCount: 2 }),
    ]);

    expect(counts.get("a")).toBe(3);
    expect(counts.get("b")).toBe(3);
  });
});
