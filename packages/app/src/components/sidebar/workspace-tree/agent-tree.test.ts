import { describe, expect, it } from "vitest";
import {
  buildWorkspaceAgentTree,
  collectPaseoAgentIds,
  type WorkspaceAgentNode,
} from "./agent-tree";

function node(
  overrides: Partial<WorkspaceAgentNode> & Pick<WorkspaceAgentNode, "id">,
): WorkspaceAgentNode {
  return {
    kind: "paseo",
    parentAgentId: null,
    workspaceId: "ws",
    title: null,
    status: "idle",
    provider: "claude",
    requiresAttention: false,
    attentionReason: null,
    pendingPermissionCount: 0,
    createdAt: 0,
    ...overrides,
  };
}

describe("buildWorkspaceAgentTree", () => {
  it("returns an empty tree for no agents", () => {
    expect(buildWorkspaceAgentTree([])).toEqual([]);
  });

  it("treats parentless agents as roots", () => {
    const roots = buildWorkspaceAgentTree([node({ id: "a" }), node({ id: "b" })]);
    expect(roots.map((r) => r.agent.id)).toEqual(["a", "b"]);
    expect(roots.every((r) => r.children.length === 0)).toBe(true);
  });

  it("nests subagents under their parent in the same workspace", () => {
    const roots = buildWorkspaceAgentTree([
      node({ id: "parent", createdAt: 1 }),
      node({ id: "child", parentAgentId: "parent", createdAt: 2 }),
    ]);
    expect(roots.map((r) => r.agent.id)).toEqual(["parent"]);
    expect(roots[0].children.map((c) => c.agent.id)).toEqual(["child"]);
  });

  it("nests to arbitrary depth", () => {
    const roots = buildWorkspaceAgentTree([
      node({ id: "root", createdAt: 1 }),
      node({ id: "child", parentAgentId: "root", createdAt: 2 }),
      node({ id: "grandchild", parentAgentId: "child", createdAt: 3 }),
      node({ id: "great", parentAgentId: "grandchild", createdAt: 4 }),
    ]);
    expect(roots.map((r) => r.agent.id)).toEqual(["root"]);
    expect(roots[0].children[0].agent.id).toBe("child");
    expect(roots[0].children[0].children[0].agent.id).toBe("grandchild");
    expect(roots[0].children[0].children[0].children[0].agent.id).toBe("great");
  });

  it("treats a cross-workspace subagent (parent absent from set) as a root", () => {
    const roots = buildWorkspaceAgentTree([
      node({ id: "cross", parentAgentId: "parent-in-another-workspace", createdAt: 1 }),
    ]);
    expect(roots.map((r) => r.agent.id)).toEqual(["cross"]);
    expect(roots[0].children).toEqual([]);
  });

  it("orders siblings oldest-first at every level", () => {
    const roots = buildWorkspaceAgentTree([
      node({ id: "third", parentAgentId: "parent", createdAt: 30 }),
      node({ id: "parent", createdAt: 1 }),
      node({ id: "first", parentAgentId: "parent", createdAt: 10 }),
      node({ id: "second", parentAgentId: "parent", createdAt: 20 }),
    ]);
    expect(roots.map((r) => r.agent.id)).toEqual(["parent"]);
    expect(roots[0].children.map((c) => c.agent.id)).toEqual(["first", "second", "third"]);
  });

  it("keeps a self-parented agent visible as a root", () => {
    const roots = buildWorkspaceAgentTree([node({ id: "loop", parentAgentId: "loop" })]);
    expect(roots.map((r) => r.agent.id)).toEqual(["loop"]);
    expect(roots[0].children).toEqual([]);
  });

  it("keeps agents in a parentage cycle visible instead of dropping them", () => {
    const roots = buildWorkspaceAgentTree([
      node({ id: "a", parentAgentId: "b", createdAt: 1 }),
      node({ id: "b", parentAgentId: "a", createdAt: 2 }),
    ]);
    // Every edge in the cycle would close a loop, so each member is promoted to
    // a root. Neither disappears, and neither nests under the other.
    expect(roots.map((r) => r.agent.id)).toEqual(["a", "b"]);
    expect(roots.every((r) => r.children.length === 0)).toBe(true);
  });
});

describe("collectPaseoAgentIds", () => {
  it("returns nothing for an empty tree", () => {
    expect(collectPaseoAgentIds([])).toEqual([]);
  });

  it("collects Paseo agents at every depth", () => {
    const roots = buildWorkspaceAgentTree([
      node({ id: "root", createdAt: 1 }),
      node({ id: "child", parentAgentId: "root", createdAt: 2 }),
      node({ id: "grandchild", parentAgentId: "child", createdAt: 3 }),
      node({ id: "second-root", createdAt: 4 }),
    ]);
    // A nested Paseo subagent can own provider subagents too, so it is a
    // hydration target just like a root.
    expect(collectPaseoAgentIds(roots).sort()).toEqual([
      "child",
      "grandchild",
      "root",
      "second-root",
    ]);
  });

  it("skips provider subagents, which cannot own children of their own", () => {
    const roots = buildWorkspaceAgentTree([
      node({ id: "parent", createdAt: 1 }),
      node({ id: "prov", kind: "provider", parentAgentId: "parent", createdAt: 2 }),
    ]);
    expect(collectPaseoAgentIds(roots)).toEqual(["parent"]);
  });
});
