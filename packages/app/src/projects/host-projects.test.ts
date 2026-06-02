import { describe, expect, it } from "vitest";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import type { WorkspaceStructureProject } from "@/projects/workspace-structure";
import {
  buildHostProjectList,
  canCreateWorktreeForProjectKind,
  hostProjectFromRoute,
  hostProjectFromWorkspace,
  resolveInitialWorktreeProject,
  resolveSelectedHostProject,
  type HostProjectListItem,
} from "./host-project-model";

function structureProject(input: Partial<WorkspaceStructureProject>): WorkspaceStructureProject {
  return {
    projectKey: input.projectKey ?? "project-a",
    projectName: input.projectName ?? "Project A",
    projectKind: input.projectKind ?? "git",
    iconWorkingDir: input.iconWorkingDir ?? "/repo/a",
    workspaceKeys: input.workspaceKeys ?? ["workspace-a"],
  };
}

function hostProject(input: Partial<HostProjectListItem>): HostProjectListItem {
  return {
    serverId: input.serverId ?? "host-a",
    projectKey: input.projectKey ?? "project-a",
    projectName: input.projectName ?? "Project A",
    projectKind: input.projectKind ?? "git",
    iconWorkingDir: input.iconWorkingDir ?? "/repo/a",
    workspaceKeys: input.workspaceKeys ?? ["workspace-a"],
    canCreateWorktree: input.canCreateWorktree ?? true,
  };
}

function workspace(input: Partial<WorkspaceDescriptor>): WorkspaceDescriptor {
  return {
    id: input.id ?? "workspace-a",
    projectId: input.projectId ?? "project-a",
    projectDisplayName: input.projectDisplayName ?? "Project A",
    projectRootPath: input.projectRootPath ?? "/repo/a",
    workspaceDirectory: input.workspaceDirectory ?? "/repo/a",
    projectKind: input.projectKind ?? "git",
    workspaceKind: input.workspaceKind ?? "local_checkout",
    name: input.name ?? "main",
    status: input.status ?? "done",
    statusEnteredAt: input.statusEnteredAt ?? null,
    archivingAt: input.archivingAt ?? null,
    diffStat: input.diffStat ?? null,
    scripts: input.scripts ?? [],
  };
}

const routeProject = hostProject({
  projectKey: "route-project",
  projectName: "Route Project",
  iconWorkingDir: "/repo/route",
});
const lastActiveProject = hostProject({
  projectKey: "last-project",
  projectName: "Last Project",
  iconWorkingDir: "/repo/last",
});
const firstProject = hostProject({
  projectKey: "first-project",
  projectName: "First Project",
  iconWorkingDir: "/repo/first",
});

describe("host project list", () => {
  it("preserves workspace-structure order and project metadata", () => {
    expect(
      buildHostProjectList({
        serverId: "host-a",
        projects: [
          structureProject({
            projectKey: "project-b",
            projectName: "Project B",
            projectKind: "directory",
            iconWorkingDir: "/repo/b",
            workspaceKeys: ["workspace-b"],
          }),
          structureProject({
            projectKey: "project-a",
            projectName: "Project A",
            projectKind: "git",
            iconWorkingDir: "/repo/a",
            workspaceKeys: ["workspace-a"],
          }),
        ],
      }),
    ).toEqual([
      {
        serverId: "host-a",
        projectKey: "project-b",
        projectName: "Project B",
        projectKind: "directory",
        iconWorkingDir: "/repo/b",
        workspaceKeys: ["workspace-b"],
        canCreateWorktree: false,
      },
      {
        serverId: "host-a",
        projectKey: "project-a",
        projectName: "Project A",
        projectKind: "git",
        iconWorkingDir: "/repo/a",
        workspaceKeys: ["workspace-a"],
        canCreateWorktree: true,
      },
    ]);
  });

  it("keeps worktree capability separate from project listability", () => {
    expect(canCreateWorktreeForProjectKind("git")).toBe(true);
    expect(canCreateWorktreeForProjectKind("directory")).toBe(false);
  });

  it("uses route project before last active project when it can create worktrees", () => {
    expect(
      resolveInitialWorktreeProject({
        routeProject,
        lastActiveProject,
        projects: [firstProject],
      }),
    ).toEqual(routeProject);
  });

  it("skips non-worktree route and last-active projects", () => {
    expect(
      resolveInitialWorktreeProject({
        routeProject: { ...routeProject, projectKind: "directory", canCreateWorktree: false },
        lastActiveProject: {
          ...lastActiveProject,
          projectKind: "directory",
          canCreateWorktree: false,
        },
        projects: [
          { ...firstProject, projectKind: "directory", canCreateWorktree: false },
          hostProject({ projectKey: "git-project", projectName: "Git Project" }),
        ],
      }),
    ).toMatchObject({ projectKey: "git-project" });
  });

  it("leaves the project empty when no worktree-capable project is available", () => {
    expect(
      resolveInitialWorktreeProject({
        routeProject: null,
        lastActiveProject: null,
        projects: [{ ...firstProject, projectKind: "directory", canCreateWorktree: false }],
      }),
    ).toBeNull();
  });

  it("keeps a selected route project available before project hydration", () => {
    expect(
      resolveSelectedHostProject({
        selectedProjectKey: routeProject.projectKey,
        projects: [],
        routeProject,
        lastActiveProject: null,
      }),
    ).toEqual(routeProject);
  });

  it("converts route project only when it has a key and source directory", () => {
    expect(
      hostProjectFromRoute({
        serverId: "host-a",
        projectId: "project-a",
        displayName: "Project A",
        sourceDirectory: "/repo/a",
      }),
    ).toEqual({
      serverId: "host-a",
      projectKey: "project-a",
      projectName: "Project A",
      projectKind: "git",
      iconWorkingDir: "/repo/a",
      workspaceKeys: [],
      canCreateWorktree: true,
    });
    expect(hostProjectFromRoute({ serverId: "host-a", projectId: "project-a" })).toBeNull();
  });

  it("converts last active workspaces with matching worktree capability", () => {
    expect(hostProjectFromWorkspace({ serverId: "host-a", workspace: workspace({}) })).toEqual({
      serverId: "host-a",
      projectKey: "project-a",
      projectName: "Project A",
      projectKind: "git",
      iconWorkingDir: "/repo/a",
      workspaceKeys: ["workspace-a"],
      canCreateWorktree: true,
    });

    expect(
      hostProjectFromWorkspace({
        serverId: "host-a",
        workspace: workspace({ projectKind: "directory" }),
      }),
    ).toMatchObject({ projectKind: "directory", canCreateWorktree: false });
  });
});
