import { describe, expect, it } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";

import { buildSidebarShortcutModel, getRelativeSidebarShortcutTarget } from "./sidebar-shortcuts";

function workspace(input: {
  serverId: string;
  workspaceId: string;
  workspaceDirectory: string;
  name: string;
  projectKey?: string;
}): SidebarWorkspaceEntry {
  return {
    workspaceKey: `${input.serverId}:${input.workspaceId}`,
    serverId: input.serverId,
    workspaceId: input.workspaceId,
    projectKey: input.projectKey ?? "project-default",
    workspaceDirectory: input.workspaceDirectory,
    projectKind: "git",
    workspaceKind: "checkout",
    name: input.name,
    statusBucket: "done",
    archivingAt: null,
    diffStat: null,
    scripts: [],
    hasRunningScripts: false,
  };
}

function project(projectKey: string, workspaces: SidebarWorkspaceEntry[]): SidebarProjectEntry {
  return {
    projectKey,
    projectName: projectKey,
    projectKind: "git",
    iconWorkingDir: workspaces[0]?.workspaceDirectory ?? "",
    workspaces,
  };
}

describe("buildSidebarShortcutModel", () => {
  it("builds shortcut targets in visual order and excludes collapsed projects", () => {
    const projects = [
      project("p1", [
        workspace({
          serverId: "s1",
          workspaceId: "ws-main",
          workspaceDirectory: "/repo/main",
          name: "main",
        }),
        workspace({
          serverId: "s1",
          workspaceId: "ws-feat-a",
          workspaceDirectory: "/repo/feat-a",
          name: "feat-a",
        }),
      ]),
      project("p2", [
        workspace({
          serverId: "s1",
          workspaceId: "ws-repo2-main",
          workspaceDirectory: "/repo2/main",
          name: "main",
        }),
        workspace({
          serverId: "s1",
          workspaceId: "ws-repo2-feat-a",
          workspaceDirectory: "/repo2/feat-a",
          name: "feat-a",
        }),
      ]),
    ];

    const model = buildSidebarShortcutModel({
      projects,
      collapsedProjectKeys: new Set<string>(["p2"]),
    });

    expect(model.shortcutTargets).toEqual([
      { serverId: "s1", workspaceId: "ws-main" },
      { serverId: "s1", workspaceId: "ws-feat-a" },
    ]);
    expect(model.shortcutIndexByWorkspaceKey.get("s1:ws-main")).toBe(1);
    expect(model.shortcutIndexByWorkspaceKey.get("s1:ws-feat-a")).toBe(2);
    expect(model.shortcutIndexByWorkspaceKey.get("s1:ws-repo2-main")).toBeUndefined();
  });

  it("limits shortcuts to 9", () => {
    const workspaces = Array.from({ length: 20 }, (_, index) =>
      workspace({
        serverId: "s",
        workspaceId: `ws-${index + 1}`,
        workspaceDirectory: `/repo/w${index + 1}`,
        name: `w${index + 1}`,
      }),
    );
    const projects = [project("p", workspaces)];

    const model = buildSidebarShortcutModel({
      projects,
      collapsedProjectKeys: new Set<string>(),
    });

    expect(model.shortcutTargets).toHaveLength(9);
    expect(model.shortcutTargets[0]).toEqual({ serverId: "s", workspaceId: "ws-1" });
    expect(model.shortcutTargets[8]).toEqual({ serverId: "s", workspaceId: "ws-9" });
  });

  it("still excludes collapsed single-workspace git projects because they are not flattened", () => {
    const projects = [
      project("p1", [
        workspace({
          serverId: "s1",
          workspaceId: "ws-main",
          workspaceDirectory: "/repo/main",
          name: "main",
        }),
      ]),
    ];

    const model = buildSidebarShortcutModel({
      projects,
      collapsedProjectKeys: new Set<string>(["p1"]),
    });

    expect(model.shortcutTargets).toEqual([]);
  });
});

describe("getRelativeSidebarShortcutTarget", () => {
  const targets = [
    { serverId: "s1", workspaceId: "ws-1" },
    { serverId: "s1", workspaceId: "ws-2" },
    { serverId: "s1", workspaceId: "ws-3" },
  ];

  it("moves backward and forward through the numbered shortcut target list", () => {
    expect(
      getRelativeSidebarShortcutTarget({
        targets,
        currentTarget: { serverId: "s1", workspaceId: "ws-2" },
        delta: -1,
      }),
    ).toEqual({ serverId: "s1", workspaceId: "ws-1" });

    expect(
      getRelativeSidebarShortcutTarget({
        targets,
        currentTarget: { serverId: "s1", workspaceId: "ws-2" },
        delta: 1,
      }),
    ).toEqual({ serverId: "s1", workspaceId: "ws-3" });
  });

  it("wraps around the numbered shortcut target list", () => {
    expect(
      getRelativeSidebarShortcutTarget({
        targets,
        currentTarget: { serverId: "s1", workspaceId: "ws-1" },
        delta: -1,
      }),
    ).toEqual({ serverId: "s1", workspaceId: "ws-3" });

    expect(
      getRelativeSidebarShortcutTarget({
        targets,
        currentTarget: { serverId: "s1", workspaceId: "ws-3" },
        delta: 1,
      }),
    ).toEqual({ serverId: "s1", workspaceId: "ws-1" });
  });

  it("falls back to the nearest edge when the current route is not in the numbered list", () => {
    expect(
      getRelativeSidebarShortcutTarget({
        targets,
        currentTarget: { serverId: "s1", workspaceId: "ws-hidden" },
        delta: 1,
      }),
    ).toEqual({ serverId: "s1", workspaceId: "ws-1" });

    expect(
      getRelativeSidebarShortcutTarget({
        targets,
        currentTarget: { serverId: "s1", workspaceId: "ws-hidden" },
        delta: -1,
      }),
    ).toEqual({ serverId: "s1", workspaceId: "ws-3" });
  });
});
