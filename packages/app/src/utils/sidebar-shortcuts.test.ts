import { describe, expect, it } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";

import { buildSidebarShortcutModel } from "./sidebar-shortcuts";

function workspace(serverId: string, cwd: string): SidebarWorkspaceEntry {
  return {
    workspaceKey: `${serverId}:${cwd}`,
    serverId,
    workspaceId: cwd,
    workspaceKind: "local_checkout",
    name: cwd,
    statusBucket: "done",
    diffStat: null,
  };
}

function project(projectKey: string, workspaces: SidebarWorkspaceEntry[]): SidebarProjectEntry {
  return {
    projectKey,
    projectName: projectKey,
    projectKind: "git",
    iconWorkingDir: workspaces[0]?.workspaceId ?? "",
    statusBucket: "done",
    activeCount: 0,
    totalWorkspaces: workspaces.length,
    workspaces,
  };
}

describe("buildSidebarShortcutModel", () => {
  it("builds shortcut targets in visual order and excludes collapsed projects", () => {
    const projects = [
      project("p1", [workspace("s1", "/repo/main"), workspace("s1", "/repo/feat-a")]),
      project("p2", [workspace("s1", "/repo2/main"), workspace("s1", "/repo2/feat-a")]),
    ];

    const model = buildSidebarShortcutModel({
      projects,
      collapsedProjectKeys: new Set<string>(["p2"]),
    });

    expect(model.visibleTargets).toEqual([
      { serverId: "s1", workspaceId: "/repo/main" },
      { serverId: "s1", workspaceId: "/repo/feat-a" },
    ]);
    expect(model.shortcutTargets).toEqual([
      { serverId: "s1", workspaceId: "/repo/main" },
      { serverId: "s1", workspaceId: "/repo/feat-a" },
    ]);
    expect(model.shortcutIndexByWorkspaceKey.get("s1:/repo/main")).toBe(1);
    expect(model.shortcutIndexByWorkspaceKey.get("s1:/repo/feat-a")).toBe(2);
    expect(model.shortcutIndexByWorkspaceKey.get("s1:/repo2/main")).toBeUndefined();
  });

  it("limits shortcuts to 9", () => {
    const workspaces = Array.from({ length: 20 }, (_, index) =>
      workspace("s", `/repo/w${index + 1}`),
    );
    const projects = [project("p", workspaces)];

    const model = buildSidebarShortcutModel({
      projects,
      collapsedProjectKeys: new Set<string>(),
    });

    expect(model.visibleTargets).toHaveLength(20);
    expect(model.visibleTargets[19]).toEqual({ serverId: "s", workspaceId: "/repo/w20" });
    expect(model.shortcutTargets).toHaveLength(9);
    expect(model.shortcutTargets[0]).toEqual({ serverId: "s", workspaceId: "/repo/w1" });
    expect(model.shortcutTargets[8]).toEqual({ serverId: "s", workspaceId: "/repo/w9" });
  });

  it("still excludes collapsed single-workspace git projects because they are not flattened", () => {
    const projects = [project("p1", [workspace("s1", "/repo/main")])];

    const model = buildSidebarShortcutModel({
      projects,
      collapsedProjectKeys: new Set<string>(["p1"]),
    });

    expect(model.visibleTargets).toEqual([]);
    expect(model.shortcutTargets).toEqual([]);
  });
});
