import { describe, expect, it } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/sidebar-workspaces-view-model";
import { buildPinnedSidebarKeys, splitPinnedSidebarGroups } from "@/hooks/use-sidebar-pins";

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
        pinAssignedAtByKey: { w1: "2026-01-01T00:00:00Z" },
      },
      pinnedWorkspaceOrder: [],
    });
    expect(result.pinnedChats).toHaveLength(1);
    expect(result.unpinnedProjects).toEqual([{ ...projects[0], workspaces: [] }]);
  });

  it("keeps a genuinely empty project so its new-workspace row stays reachable", () => {
    const projects = [project("p1", [])];
    const result = splitPinnedSidebarGroups({
      projects,
      keys: { pinnedWorkspaceKeys: [], pinAssignedAtByKey: {} },
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
        pinAssignedAtByKey: { w1: "2026-01-01T00:00:00Z" },
      },
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
        pinAssignedAtByKey: {
          older: "2026-01-01T00:00:00Z",
          newer: "2026-02-01T00:00:00Z",
        },
      },
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
        pinAssignedAtByKey: {
          older: "2026-01-01T00:00:00Z",
          newer: "2026-02-01T00:00:00Z",
          new: "2026-03-01T00:00:00Z",
        },
      },
      pinnedWorkspaceOrder: ["older", "newer"],
    });

    expect(result.pinnedChats.map((workspace) => workspace.workspaceKey)).toEqual([
      "new",
      "older",
      "newer",
    ]);
  });
});

describe("buildPinnedSidebarKeys", () => {
  it("keeps only workspaces in the active group on hosts that support pin groups", () => {
    const projects = [project("p1", [placement("active"), placement("other"), placement("none")])];
    const workspaceMaps = new Map([
      [
        "s1",
        new Map([
          ["active", { pinGroupId: "team", pinGroupAssignedAt: "2026-03-01T00:00:00Z" }],
          ["other", { pinGroupId: "review", pinGroupAssignedAt: "2026-02-01T00:00:00Z" }],
          ["none", { pinGroupId: null, pinGroupAssignedAt: null }],
        ]),
      ],
    ]);

    expect(
      buildPinnedSidebarKeys({
        projects,
        workspaceMaps,
        supportsPinGroupsByServerId: new Map([["s1", true]]),
        activePinGroup: { groupId: "team", serverId: "s1" },
      }),
    ).toEqual({
      pinnedWorkspaceKeys: ["active"],
      pinAssignedAtByKey: { active: "2026-03-01T00:00:00Z" },
    });
  });

  it("does not fall back to legacy pinnedAt when pin groups are unavailable", () => {
    const projects = [project("p1", [placement("legacy")])];

    expect(
      buildPinnedSidebarKeys({
        projects,
        workspaceMaps: new Map([["s1", new Map([["legacy", { pinGroupId: "default" }]])]]),
        supportsPinGroupsByServerId: new Map([["s1", false]]),
        activePinGroup: { groupId: "default", serverId: "s1" },
      }),
    ).toEqual({
      pinnedWorkspaceKeys: [],
      pinAssignedAtByKey: {},
    });
  });

  it("renders a custom group only from its owning capable host", () => {
    const projects = [
      project("p1", [placement("host-a-team", "host-a"), placement("host-b-team", "host-b")]),
    ];

    expect(
      buildPinnedSidebarKeys({
        projects,
        workspaceMaps: new Map([
          ["host-a", new Map([["host-a-team", { pinGroupId: "team" }]])],
          ["host-b", new Map([["host-b-team", { pinGroupId: "team" }]])],
        ]),
        supportsPinGroupsByServerId: new Map([
          ["host-a", true],
          ["host-b", true],
        ]),
        activePinGroup: { groupId: "team", serverId: "host-a" },
      }),
    ).toEqual({
      pinnedWorkspaceKeys: ["host-a-team"],
      pinAssignedAtByKey: {},
    });
  });

  it("keeps the default group isolated to its selected host", () => {
    const projects = [
      project("p1", [placement("host-a-default", "host-a"), placement("host-b-default", "host-b")]),
    ];

    expect(
      buildPinnedSidebarKeys({
        projects,
        workspaceMaps: new Map([
          ["host-a", new Map([["host-a-default", { pinGroupId: "default" }]])],
          ["host-b", new Map([["host-b-default", { pinGroupId: "default" }]])],
        ]),
        supportsPinGroupsByServerId: new Map([
          ["host-a", true],
          ["host-b", true],
        ]),
        activePinGroup: { groupId: "default", serverId: "host-b" },
      }),
    ).toEqual({
      pinnedWorkspaceKeys: ["host-b-default"],
      pinAssignedAtByKey: {},
    });
  });
});
