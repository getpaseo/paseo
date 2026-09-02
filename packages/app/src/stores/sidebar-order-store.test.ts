import { describe, expect, it } from "vitest";
import { migrateSidebarOrderState, renameOrderKey } from "./sidebar-order-store";

describe("migrateSidebarOrderState", () => {
  it("prefixes legacy per-server workspace order with the source server id", () => {
    const migrated = migrateSidebarOrderState({
      projectOrderByServerId: {
        "host-a": ["project-a"],
        "host-b": ["project-a"],
      },
      workspaceOrderByServerAndProject: {
        "host-a::project-a": ["main", "feature"],
        "host-b::project-a": ["main"],
      },
    });

    expect(migrated).toEqual({
      projectOrder: ["project-a"],
      projectGroupOrder: [],
      pinnedWorkspaceOrder: [],
      workspaceOrderByProject: {
        "project-a": ["host-a:main", "host-a:feature", "host-b:main"],
      },
    });
  });

  it("normalizes pinned workspace order", () => {
    const migrated = migrateSidebarOrderState({
      pinnedWorkspaceOrder: [" host-a:one ", "host-a:one", "", "host-b:two"],
    });

    expect(migrated.pinnedWorkspaceOrder).toEqual(["host-a:one", "host-b:two"]);
  });
});

describe("project group order", () => {
  it("migrates a state saved before groups had an order", () => {
    expect(migrateSidebarOrderState({ projectOrder: ["a"] }).projectGroupOrder).toEqual([]);
    expect(
      migrateSidebarOrderState({ projectGroupOrder: [" client x ", "", "client y", "client x"] })
        .projectGroupOrder,
    ).toEqual(["client x", "client y"]);
  });

  it("moves a renamed group's entry to its new key and drops a duplicate", () => {
    expect(renameOrderKey(["a", "b", "c"], "b", "z")).toEqual(["a", "z", "c"]);
    expect(renameOrderKey(["a", "b", "c"], "b", "c")).toEqual(["a", "c"]);
    expect(renameOrderKey(["a", "b"], "x", "y")).toEqual(["a", "b"]);
  });
});
