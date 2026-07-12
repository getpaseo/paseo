import { describe, expect, it } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/sidebar-workspaces-view-model";
import {
  buildPinAwareShortcutProjects,
  PINNED_CHATS_PSEUDO_PROJECT_KEY,
  splitPinnedSidebarGroups,
} from "@/hooks/use-sidebar-pins";

function placement(workspaceKey: string): SidebarWorkspacePlacement {
  return {
    workspaceKey,
    serverId: "s1",
    workspaceId: workspaceKey,
    projectKey: "p1",
    projectName: "Project 1",
    projectKind: "git",
    workspaceKind: "worktree",
    name: workspaceKey,
  };
}

function project(projectKey: string, workspaces: SidebarWorkspacePlacement[]): SidebarProjectEntry {
  return {
    projectKey,
    projectName: projectKey,
    projectKind: "git",
    iconWorkingDir: "",
    hosts: [],
    workspaces,
  };
}

describe("splitPinnedSidebarGroups", () => {
  it("drops the empty shell when every chat of a project is pinned", () => {
    const only = placement("w1");
    const projects = [project("p1", [only])];
    const result = splitPinnedSidebarGroups({
      projects,
      keys: {
        pinnedWorkspaceKeys: ["w1"],
        pinnedAtByKey: { w1: "2026-01-01T00:00:00Z" },
      },
    });
    expect(result.pinnedChats).toHaveLength(1);
    expect(result.unpinnedProjects).toHaveLength(0);
  });

  it("keeps a genuinely empty project so its new-workspace row stays reachable", () => {
    const projects = [project("p1", [])];
    const result = splitPinnedSidebarGroups({
      projects,
      keys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
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
    });
    expect(result.pinnedChats.map((w) => w.workspaceKey)).toEqual(["w1"]);
    expect(result.unpinnedProjects[0]?.workspaces.map((w) => w.workspaceKey)).toEqual(["w2"]);
  });
});

describe("buildPinAwareShortcutProjects", () => {
  const groups = {
    pinnedChats: [placement("pinned-chat")],
    unpinnedProjects: [project("unpinned-proj", [placement("uc")])],
  };

  it("floats pinned chats to the front when Pinned is expanded", () => {
    const ordered = buildPinAwareShortcutProjects(groups);
    expect(ordered.map((p) => p.projectKey)).toEqual([
      PINNED_CHATS_PSEUDO_PROJECT_KEY,
      "unpinned-proj",
    ]);
  });

  it("excludes hidden pinned rows from numbering when Pinned is collapsed", () => {
    const ordered = buildPinAwareShortcutProjects(groups, { pinnedCollapsed: true });
    expect(ordered.map((p) => p.projectKey)).toEqual(["unpinned-proj"]);
  });
});
