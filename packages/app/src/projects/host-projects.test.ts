import { describe, expect, test } from "vitest";
import type { HostProjectListItem } from "./host-project-model";
import {
  canCreateWorkspaceForHostProject,
  getHostProjectId,
  getHostProjectSourceDirectory,
  hostProjectFromRoute,
} from "./host-project-model";

function project(): HostProjectListItem {
  return {
    projectKey: "remote:github.com/acme/app",
    projectName: "acme/app",
    projectKind: "git",
    iconWorkingDir: "/repo/a",
    hosts: [
      {
        serverId: "host-a",
        projectId: "prj_a",
        iconWorkingDir: "/repo/a",
        canCreateWorktree: true,
      },
      {
        serverId: "host-b",
        projectId: "prj_b",
        iconWorkingDir: "/repo/b",
        canCreateWorktree: true,
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

  test("builds an unhydrated route project around the routed project id", () => {
    expect(
      hostProjectFromRoute({
        serverId: "host-a",
        projectId: "prj_a",
        displayName: "App",
        sourceDirectory: "/repo/a",
      }),
    ).toMatchObject({
      projectKey: "prj_a",
      hosts: [{ serverId: "host-a", projectId: "prj_a" }],
    });
  });
});
