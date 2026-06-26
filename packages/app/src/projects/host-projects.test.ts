import { describe, expect, it } from "vitest";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import type { WorkspaceStructureProject } from "@/projects/workspace-structure";
import {
  buildHostProjectList,
  canCreateWorkspaceForHostProject,
  canCreateWorktreeForProjectKind,
  filterWorkspaceProjectsForHost,
  getHostProjectSourceDirectory,
  hostProjectFromRoute,
  hostProjectFromWorkspace,
  resolveInitialWorkspaceProject,
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
    hosts: input.hosts ?? [
      {
        serverId: "host-a",
        iconWorkingDir: input.iconWorkingDir ?? "/repo/a",
        canCreateWorktree: input.projectKind !== "directory",
      },
    ],
    workspaceKeys: input.workspaceKeys ?? ["workspace-a"],
  };
}

function hostProject(input: Partial<HostProjectListItem>): HostProjectListItem {
  return {
    projectKey: input.projectKey ?? "project-a",
    projectName: input.projectName ?? "Project A",
    projectKind: input.projectKind ?? "git",
    iconWorkingDir: input.iconWorkingDir ?? "/repo/a",
    hosts: input.hosts ?? [
      {
        serverId: "host-a",
        iconWorkingDir: input.iconWorkingDir ?? "/repo/a",
        canCreateWorktree: true,
      },
    ],
    workspaceKeys: input.workspaceKeys ?? ["workspace-a"],
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
        projects: [
          structureProject({
            projectKey: "project-b",
            projectName: "Project B",
            projectKind: "directory",
            iconWorkingDir: "/repo/b",
            workspaceKeys: ["workspace-b"],
            hosts: [{ serverId: "host-a", iconWorkingDir: "/repo/b", canCreateWorktree: false }],
          }),
          structureProject({
            projectKey: "project-a",
            projectName: "Project A",
            projectKind: "git",
            iconWorkingDir: "/repo/a",
            workspaceKeys: ["workspace-a"],
            hosts: [{ serverId: "host-a", iconWorkingDir: "/repo/a", canCreateWorktree: true }],
          }),
        ],
      }),
    ).toEqual([
      {
        projectKey: "project-b",
        projectName: "Project B",
        projectKind: "directory",
        iconWorkingDir: "/repo/b",
        hosts: [{ serverId: "host-a", iconWorkingDir: "/repo/b", canCreateWorktree: false }],
        workspaceKeys: ["workspace-b"],
      },
      {
        projectKey: "project-a",
        projectName: "Project A",
        projectKind: "git",
        iconWorkingDir: "/repo/a",
        hosts: [{ serverId: "host-a", iconWorkingDir: "/repo/a", canCreateWorktree: true }],
        workspaceKeys: ["workspace-a"],
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
        routeProject: {
          ...routeProject,
          projectKind: "directory",
          hosts: [{ serverId: "host-a", iconWorkingDir: "/repo/route", canCreateWorktree: false }],
        },
        lastActiveProject: {
          ...lastActiveProject,
          projectKind: "directory",
          hosts: [{ serverId: "host-a", iconWorkingDir: "/repo/last", canCreateWorktree: false }],
        },
        projects: [
          {
            ...firstProject,
            projectKind: "directory",
            hosts: [
              { serverId: "host-a", iconWorkingDir: "/repo/first", canCreateWorktree: false },
            ],
          },
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
        projects: [
          {
            ...firstProject,
            projectKind: "directory",
            hosts: [
              { serverId: "host-a", iconWorkingDir: "/repo/first", canCreateWorktree: false },
            ],
          },
        ],
      }),
    ).toBeNull();
  });

  it("filters new-workspace projects to the selected host", () => {
    const hostAOnly = hostProject({
      projectKey: "host-a-project",
      hosts: [{ serverId: "host-a", iconWorkingDir: "/repo/a", canCreateWorktree: true }],
    });
    const hostBOnly = hostProject({
      projectKey: "host-b-project",
      hosts: [{ serverId: "host-b", iconWorkingDir: "/repo/b", canCreateWorktree: true }],
    });

    expect(
      filterWorkspaceProjectsForHost({
        projects: [hostAOnly, hostBOnly],
        serverId: "host-b",
        allowAllProjects: false,
      }).map((project) => project.projectKey),
    ).toEqual(["host-b-project"]);
  });

  it("allows directory projects only when workspace multiplicity is supported", () => {
    const directoryProject = hostProject({
      projectKey: "directory-project",
      projectKind: "directory",
      hosts: [{ serverId: "host-a", iconWorkingDir: "/repo/directory", canCreateWorktree: false }],
    });

    expect(
      canCreateWorkspaceForHostProject({
        project: directoryProject,
        serverId: "host-a",
        allowAllProjects: false,
      }),
    ).toBe(false);
    expect(
      canCreateWorkspaceForHostProject({
        project: directoryProject,
        serverId: "host-a",
        allowAllProjects: true,
      }),
    ).toBe(true);
  });

  it("falls back when the route project is not available on the selected host", () => {
    const selectedHostProject = hostProject({
      projectKey: "selected-host-project",
      hosts: [
        { serverId: "host-b", iconWorkingDir: "/repo/selected-host", canCreateWorktree: true },
      ],
    });

    expect(
      resolveInitialWorkspaceProject({
        routeProject,
        lastActiveProject: null,
        projects: [selectedHostProject],
        serverId: "host-b",
        allowAllProjects: false,
      }),
    ).toEqual(selectedHostProject);
  });

  it("resolves the selected host project source directory", () => {
    const project = hostProject({
      hosts: [
        { serverId: "host-a", iconWorkingDir: "/repo/a", canCreateWorktree: true },
        { serverId: "host-b", iconWorkingDir: "/repo/b", canCreateWorktree: true },
      ],
    });

    expect(getHostProjectSourceDirectory(project, "host-b")).toBe("/repo/b");
    expect(getHostProjectSourceDirectory(project, "host-c")).toBeNull();
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
      projectKey: "project-a",
      projectName: "Project A",
      projectKind: "git",
      iconWorkingDir: "/repo/a",
      hosts: [{ serverId: "host-a", iconWorkingDir: "/repo/a", canCreateWorktree: true }],
      workspaceKeys: [],
    });
    expect(hostProjectFromRoute({ serverId: "host-a", projectId: "project-a" })).toBeNull();
  });

  it("converts last active workspaces with matching worktree capability", () => {
    expect(hostProjectFromWorkspace({ serverId: "host-a", workspace: workspace({}) })).toEqual({
      projectKey: "project-a",
      projectName: "Project A",
      projectKind: "git",
      iconWorkingDir: "/repo/a",
      hosts: [{ serverId: "host-a", iconWorkingDir: "/repo/a", canCreateWorktree: true }],
      workspaceKeys: ["host-a:workspace-a"],
    });

    expect(
      hostProjectFromWorkspace({
        serverId: "host-a",
        workspace: workspace({ projectKind: "directory" }),
      }),
    ).toMatchObject({
      projectKind: "directory",
      hosts: [{ serverId: "host-a", iconWorkingDir: "/repo/a", canCreateWorktree: false }],
    });
  });
});
