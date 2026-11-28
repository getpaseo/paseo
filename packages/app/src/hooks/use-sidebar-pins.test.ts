import { describe, expect, it } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/sidebar-workspaces-view-model";
import { splitPinnedSidebarGroups } from "@/hooks/use-sidebar-pins";

function placement(workspaceKey: string): SidebarWorkspacePlacement {
  return {
    workspaceKey,
    serverId: "s1",
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
        pinnedAtByKey: { w1: "2026-01-01T00:00:00Z" },
      },
      pinnedWorkspaceOrder: [],
      pinnedProjectKeys: [],
    });
    expect(result.pinnedChats).toHaveLength(1);
    expect(result.unpinnedProjects).toEqual([{ ...projects[0], workspaces: [] }]);
  });

  it("keeps a genuinely empty project so its new-workspace row stays reachable", () => {
    const projects = [project("p1", [])];
    const result = splitPinnedSidebarGroups({
      projects,
      keys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
      pinnedWorkspaceOrder: [],
      pinnedProjectKeys: [],
    });
    expect(result.unpinnedProjects).toHaveLength(1);
  });

  it("keeps remaining chats when only some are pinned", () => {
    const projects = [project("p1", [placement("w1"), placement("w2")])];
    const result = splitPinnedSidebarGroups({
      projects,
      keys: {
        pinnedWorkspaceKeys: ["w1"],
        pinnedAtByKey: { w1: "2026-01-01T00:00:00Z" },
      },
      pinnedWorkspaceOrder: [],
      pinnedProjectKeys: [],
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
        pinnedAtByKey: {
          older: "2026-01-01T00:00:00Z",
          newer: "2026-02-01T00:00:00Z",
        },
      },
      pinnedWorkspaceOrder: [],
      pinnedProjectKeys: [],
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
        pinnedAtByKey: {
          older: "2026-01-01T00:00:00Z",
          newer: "2026-02-01T00:00:00Z",
          new: "2026-03-01T00:00:00Z",
        },
      },
      pinnedWorkspaceOrder: ["older", "newer"],
      pinnedProjectKeys: [],
    });

    expect(result.pinnedChats.map((workspace) => workspace.workspaceKey)).toEqual([
      "new",
      "older",
      "newer",
    ]);
  });

  it("partitions pinned projects in input order", () => {
    const projects = [
      project("p1", [placement("w1")]),
      project("p2", [placement("w2")]),
      project("p3", [placement("w3")]),
    ];
    const result = splitPinnedSidebarGroups({
      projects,
      keys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
      pinnedWorkspaceOrder: [],
      pinnedProjectKeys: ["p3", "p1"],
    });

    expect(result.pinnedProjects.map((item) => item.viewKey)).toEqual(["p1", "p3"]);
    expect(result.unpinnedProjects.map((item) => item.viewKey)).toEqual(["p2"]);
  });

  it("keeps a workspace in Pinned and in its pinned project", () => {
    const projects = [
      project("p1", [placement("w1"), placement("w2")]),
      project("p2", [placement("w3")]),
    ];
    const result = splitPinnedSidebarGroups({
      projects,
      keys: {
        pinnedWorkspaceKeys: ["w1"],
        pinnedAtByKey: { w1: "2026-01-01T00:00:00Z" },
      },
      pinnedWorkspaceOrder: [],
      pinnedProjectKeys: ["p1"],
    });

    expect(result.pinnedChats.map((workspace) => workspace.workspaceKey)).toEqual(["w1"]);
    expect(result.pinnedProjects[0]?.workspaces.map((workspace) => workspace.workspaceKey)).toEqual(
      ["w1", "w2"],
    );
  });

  it("keeps a workspace pin out of an unpinned project", () => {
    const projects = [project("p1", [placement("w1"), placement("w2")])];
    const result = splitPinnedSidebarGroups({
      projects,
      keys: {
        pinnedWorkspaceKeys: ["w1"],
        pinnedAtByKey: { w1: "2026-01-01T00:00:00Z" },
      },
      pinnedWorkspaceOrder: [],
      pinnedProjectKeys: [],
    });

    expect(result.pinnedChats.map((workspace) => workspace.workspaceKey)).toEqual(["w1"]);
    expect(
      result.unpinnedProjects[0]?.workspaces.map((workspace) => workspace.workspaceKey),
    ).toEqual(["w2"]);
  });

  it("keeps Pinned order independent from workspace order inside a pinned project", () => {
    const pinnedAtByKey = {
      w1: "2026-01-01T00:00:00Z",
      w2: "2026-01-02T00:00:00Z",
    };
    const before = splitPinnedSidebarGroups({
      projects: [project("p1", [placement("w1"), placement("w2")])],
      keys: { pinnedWorkspaceKeys: ["w1", "w2"], pinnedAtByKey },
      pinnedWorkspaceOrder: ["w1", "w2"],
      pinnedProjectKeys: ["p1"],
    });
    const after = splitPinnedSidebarGroups({
      projects: [project("p1", [placement("w2"), placement("w1")])],
      keys: { pinnedWorkspaceKeys: ["w1", "w2"], pinnedAtByKey },
      pinnedWorkspaceOrder: ["w1", "w2"],
      pinnedProjectKeys: ["p1"],
    });

    expect(after.pinnedProjects[0]?.workspaces.map((workspace) => workspace.workspaceKey)).toEqual([
      "w2",
      "w1",
    ]);
    expect(before.pinnedChats.map((workspace) => workspace.workspaceKey)).toEqual(["w1", "w2"]);
    expect(after.pinnedChats.map((workspace) => workspace.workspaceKey)).toEqual(["w1", "w2"]);
  });

  it("keeps same-time pins stable when project workspace order changes", () => {
    const keys = {
      pinnedWorkspaceKeys: ["w1", "w2"],
      pinnedAtByKey: {
        w1: "2026-01-01T00:00:00Z",
        w2: "2026-01-01T00:00:00Z",
      },
    };
    const before = splitPinnedSidebarGroups({
      projects: [project("p1", [placement("w1"), placement("w2")])],
      keys,
      pinnedWorkspaceOrder: [],
      pinnedProjectKeys: ["p1"],
    });
    const after = splitPinnedSidebarGroups({
      projects: [project("p1", [placement("w2"), placement("w1")])],
      keys,
      pinnedWorkspaceOrder: [],
      pinnedProjectKeys: ["p1"],
    });

    expect(before.pinnedChats.map((workspace) => workspace.workspaceKey)).toEqual(["w1", "w2"]);
    expect(after.pinnedChats.map((workspace) => workspace.workspaceKey)).toEqual(["w1", "w2"]);
  });

  it("keeps a pinned project when all of its workspaces are individually pinned", () => {
    const projects = [project("p1", [placement("w1")])];
    const result = splitPinnedSidebarGroups({
      projects,
      keys: {
        pinnedWorkspaceKeys: ["w1"],
        pinnedAtByKey: { w1: "2026-01-01T00:00:00Z" },
      },
      pinnedWorkspaceOrder: [],
      pinnedProjectKeys: ["p1"],
    });

    expect(result.pinnedProjects[0]?.workspaces).toEqual([placement("w1")]);
  });

  it("keeps a workspace-free pinned project available", () => {
    const projects = [project("p1", [])];
    const result = splitPinnedSidebarGroups({
      projects,
      keys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
      pinnedWorkspaceOrder: [],
      pinnedProjectKeys: ["p1"],
    });

    expect(result.pinnedProjects).toEqual(projects);
  });

  it("ignores stale project keys and preserves the no-pin project reference", () => {
    const projects = [project("p1", [placement("w1")])];
    const result = splitPinnedSidebarGroups({
      projects,
      keys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
      pinnedWorkspaceOrder: [],
      pinnedProjectKeys: ["removed-project"],
    });

    expect(result.pinnedProjects).toEqual([]);
    expect(result.unpinnedProjects).toBe(projects);
  });
});
