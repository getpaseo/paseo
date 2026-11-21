import { describe, expect, it } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/sidebar-workspaces-view-model";
import { planPinnedSidebarReorder, splitPinnedSidebarGroups } from "@/hooks/use-sidebar-pins";

function placement(workspaceKey: string, serverId = "s1"): SidebarWorkspacePlacement {
  return {
    workspaceKey,
    serverId,
    workspaceId: workspaceKey,
    projectViewKey: "p1",
    projectName: "Project 1",
    projectKind: "git",
    workspaceKind: "worktree",
    name: workspaceKey,
  };
}

function project(projectKey: string, workspaces: SidebarWorkspacePlacement[]): SidebarProjectEntry {
  return {
    viewKey: projectKey,
    projectName: projectKey,
    projectKind: "git",
    iconWorkingDir: "",
    hosts: [],
    workspaces,
  };
}

describe("splitPinnedSidebarGroups", () => {
  it("keeps the project shell reachable when every chat is pinned", () => {
    const only = placement("w1");
    const projects = [project("p1", [only])];
    const result = splitPinnedSidebarGroups({
      projects,
      keys: {
        pinnedWorkspaceKeys: ["w1"],
        pinnedOrderByKey: {},
        pinnedAtByKey: { w1: "2026-01-01T00:00:00Z" },
      },
      syncedHostIds: new Set(),
      pinnedWorkspaceOrder: [],
    });
    expect(result.pinnedChats).toHaveLength(1);
    expect(result.unpinnedProjects).toEqual([{ ...projects[0], workspaces: [] }]);
  });

  it("keeps a genuinely empty project so its new-workspace row stays reachable", () => {
    const projects = [project("p1", [])];
    const result = splitPinnedSidebarGroups({
      projects,
      keys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {}, pinnedOrderByKey: {} },
      syncedHostIds: new Set(),
      pinnedWorkspaceOrder: [],
    });
    expect(result.unpinnedProjects).toHaveLength(1);
  });

  it("keeps remaining chats when only some are pinned", () => {
    const projects = [project("p1", [placement("w1"), placement("w2")])];
    const result = splitPinnedSidebarGroups({
      projects,
      keys: {
        pinnedWorkspaceKeys: ["w1"],
        pinnedOrderByKey: {},
        pinnedAtByKey: { w1: "2026-01-01T00:00:00Z" },
      },
      syncedHostIds: new Set(),
      pinnedWorkspaceOrder: [],
    });
    expect(result.pinnedChats.map((w) => w.workspaceKey)).toEqual(["w1"]);
    expect(result.unpinnedProjects[0]?.workspaces.map((w) => w.workspaceKey)).toEqual(["w2"]);
  });

  it("orders pinned chats by most-recently-pinned first", () => {
    const projects = [project("p1", [placement("older"), placement("newer")])];
    const result = splitPinnedSidebarGroups({
      projects,
      keys: {
        pinnedWorkspaceKeys: ["older", "newer"],
        pinnedOrderByKey: {},
        pinnedAtByKey: {
          older: "2026-01-01T00:00:00Z",
          newer: "2026-02-01T00:00:00Z",
        },
      },
      syncedHostIds: new Set(),
      pinnedWorkspaceOrder: [],
    });

    expect(result.pinnedChats.map((workspace) => workspace.workspaceKey)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("applies the saved order while keeping a newly pinned chat first", () => {
    const projects = [project("p1", [placement("older"), placement("newer"), placement("new")])];
    const result = splitPinnedSidebarGroups({
      projects,
      keys: {
        pinnedWorkspaceKeys: ["older", "newer", "new"],
        pinnedOrderByKey: {},
        pinnedAtByKey: {
          older: "2026-01-01T00:00:00Z",
          newer: "2026-02-01T00:00:00Z",
          new: "2026-03-01T00:00:00Z",
        },
      },
      syncedHostIds: new Set(),
      pinnedWorkspaceOrder: ["older", "newer"],
    });

    expect(result.pinnedChats.map((workspace) => workspace.workspaceKey)).toEqual([
      "new",
      "older",
      "newer",
    ]);
  });
});

describe("host pin order", () => {
  it("applies host ranks within their slots and ignores local order for upgraded hosts", () => {
    const a = placement("a");
    const b = placement("b");
    const newPin = placement("new");
    const c = placement("c", "s2");
    const d = placement("d", "s2");
    const pinGroups = splitPinnedSidebarGroups({
      projects: [project("p1", [a, b, newPin, c, d])],
      keys: {
        pinnedWorkspaceKeys: ["a", "b", "new", "c", "d"],
        pinnedAtByKey: {
          a: "2026-01-01T00:00:00Z",
          b: "2026-02-01T00:00:00Z",
          new: "2026-05-01T00:00:00Z",
          c: "2026-03-01T00:00:00Z",
          d: "2026-04-01T00:00:00Z",
        },
        pinnedOrderByKey: { a: 0, b: 1 },
      },
      syncedHostIds: new Set(["s1"]),
      pinnedWorkspaceOrder: ["b", "a", "c", "d"],
    });

    expect(pinGroups.pinnedChats).toEqual([newPin, c, d, a, b]);
    expect(planPinnedSidebarReorder(pinGroups, [c, newPin, d, a, b]).size).toBe(0);
    expect(planPinnedSidebarReorder(pinGroups, [newPin, c, d, b, a])).toEqual(
      new Map([["s1", [newPin, b, a]]]),
    );
    expect(planPinnedSidebarReorder(pinGroups, [newPin, d, c, a, b])).toEqual(
      new Map([[null, [d, c]]]),
    );
  });
});
