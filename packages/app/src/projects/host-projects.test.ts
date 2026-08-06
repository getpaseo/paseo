import { describe, expect, test } from "vitest";
import type { HostProjectListItem } from "./host-project-model";
import {
  canCreateWorkspaceForHostProject,
  getHostProjectId,
  getHostProjectSourceDirectory,
  getWorktreeSupportForHostProject,
  hostProjectFromRoute,
} from "./host-project-model";

function project(): HostProjectListItem {
  return {
    viewKey: "view:acme/app",
    projectKey: "remote:github.com/acme/app",
    projectName: "acme/app",
    projectKind: "git",
    iconWorkingDir: "/repo/a",
    hosts: [
      {
        serverId: "host-a",
        projectId: "prj_a",
        iconWorkingDir: "/repo/a",
        worktreeSupport: "supported" as const,
      },
      {
        serverId: "host-b",
        projectId: "prj_b",
        iconWorkingDir: "/repo/b",
        worktreeSupport: "supported" as const,
      },
    ],
    workspaceKeys: [],
  };
}

describe("host project lookups", () => {
  test("returns host-local ids and roots without falling back to the grouping key", () => {
    expect(getHostProjectId(project(), "host-b")).toBe("prj_b");
    expect(getHostProjectSourceDirectory(project(), "host-b")).toBe("/repo/b");
    expect(getHostProjectId(project(), "missing")).toBeNull();
  });

  test("checks workspace creation against the selected host placement", () => {
    expect(
      canCreateWorkspaceForHostProject({
        project: project(),
        serverId: "host-b",
        allowAllProjects: false,
      }),
    ).toBe(true);
  });

  test("checks worktree capability against the selected host placement", () => {
    const groupedProject = project();
    groupedProject.hosts[1] = {
      ...groupedProject.hosts[1]!,
      worktreeSupport: "unsupported" as const,
    };

    expect(getWorktreeSupportForHostProject({ project: groupedProject, serverId: "host-a" })).toBe(
      "supported",
    );
    expect(getWorktreeSupportForHostProject({ project: groupedProject, serverId: "host-b" })).toBe(
      "unsupported",
    );
    expect(getWorktreeSupportForHostProject({ project: groupedProject, serverId: "missing" })).toBe(
      "unknown",
    );
  });

  test("marks route placeholder worktree support as unknown", () => {
    const routeProject = hostProjectFromRoute({
      serverId: "host-a",
      projectId: "prj_a",
      displayName: "App",
      sourceDirectory: "/repo/a",
    });
    expect(routeProject).not.toBeNull();
    expect(routeProject!.projectKind).toBe("unknown");
    expect(getWorktreeSupportForHostProject({ project: routeProject!, serverId: "host-a" })).toBe(
      "unknown",
    );
  });

  test("builds an unhydrated route project around the routed project id", () => {
    expect(
      hostProjectFromRoute({
        serverId: "host-a",
        projectId: "prj_a",
        displayName: "App",
        sourceDirectory: "/repo/a",
      }),
    ).toMatchObject({
      projectKey: null,
      hosts: [{ serverId: "host-a", projectId: "prj_a" }],
    });
  });
});
