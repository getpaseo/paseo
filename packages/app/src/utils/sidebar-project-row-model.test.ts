import { describe, expect, it } from "vitest";
import {
  buildSidebarProjectRowModel,
  isSidebarProjectFlattened,
} from "./sidebar-project-row-model";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";

function workspace(overrides: Partial<SidebarWorkspaceEntry> = {}): SidebarWorkspaceEntry {
  return {
    workspaceKey: "srv:ws-root",
    serverId: "srv",
    workspaceId: "ws-root",
    workspaceDirectory: "/repo",
    projectKind: "git",
    workspaceKind: "checkout",
    name: "paseo",
    statusBucket: "done",
    diffStat: null,
    scripts: [],
    hasRunningScripts: false,
    ...overrides,
  };
}

function project(overrides: Partial<SidebarProjectEntry> = {}): SidebarProjectEntry {
  return {
    projectKey: "project-1",
    projectName: "paseo",
    projectKind: "git",
    iconWorkingDir: "/repo",
    statusBucket: "done",
    activeCount: 0,
    totalWorkspaces: 1,
    workspaces: [workspace()],
    ...overrides,
  };
}

describe("buildSidebarProjectRowModel", () => {
  it("flattens non-git projects with one workspace into a direct workspace row model", () => {
    const flattenedWorkspace = workspace({
      workspaceId: "ws-non-git",
      workspaceKind: "checkout",
      statusBucket: "running",
    });

    const result = buildSidebarProjectRowModel({
      project: project({
        projectKind: "directory",
        workspaces: [flattenedWorkspace],
      }),
      collapsed: false,
    });

    expect(result).toEqual({
      kind: "workspace_link",
      workspace: flattenedWorkspace,
      selected: false,
      chevron: null,
      trailingAction: "none",
    });
  });

  it("marks flattened non-git project rows as selected when their workspace is active", () => {
    const flattenedWorkspace = workspace({
      serverId: "srv-2",
      workspaceId: "ws-non-git",
    });

    const result = buildSidebarProjectRowModel({
      project: project({
        projectKind: "directory",
        workspaces: [flattenedWorkspace],
      }),
      collapsed: false,
      serverId: "srv-2",
      activeWorkspaceSelection: {
        serverId: "srv-2",
        workspaceId: "ws-non-git",
      },
    });

    expect(result).toMatchObject({
      kind: "workspace_link",
      selected: true,
    });
  });

  it("keeps single-workspace git projects as sections with the new worktree action", () => {
    const onlyWorkspace = workspace({
      workspaceId: "ws-main",
      workspaceKind: "checkout",
    });

    const result = buildSidebarProjectRowModel({
      project: project({
        projectKind: "git",
        workspaces: [onlyWorkspace],
      }),
      collapsed: true,
    });

    expect(result).toEqual({
      kind: "project_section",
      chevron: "expand",
      trailingAction: "new_worktree",
    });
  });

  it("keeps multi-workspace git projects as expandable sections with a new worktree action", () => {
    const result = buildSidebarProjectRowModel({
      project: project({
        projectKind: "git",
        workspaces: [
          workspace({ workspaceId: "ws-main", workspaceKind: "checkout" }),
          workspace({ workspaceId: "ws-feature", workspaceKind: "worktree" }),
        ],
      }),
      collapsed: true,
    });

    expect(result).toEqual({
      kind: "project_section",
      chevron: "expand",
      trailingAction: "new_worktree",
    });
  });
});

describe("isSidebarProjectFlattened", () => {
  it("returns true only for single-workspace non-git projects", () => {
    expect(
      isSidebarProjectFlattened(project({ projectKind: "git", workspaces: [workspace()] })),
    ).toBe(false);
    expect(
      isSidebarProjectFlattened(project({ projectKind: "directory", workspaces: [workspace()] })),
    ).toBe(true);
  });

  it("returns false for multi-workspace projects", () => {
    expect(
      isSidebarProjectFlattened(
        project({
          workspaces: [
            workspace({ workspaceId: "ws-main" }),
            workspace({ workspaceId: "ws-feat" }),
          ],
        }),
      ),
    ).toBe(false);
  });
});
