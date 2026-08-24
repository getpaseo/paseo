import { describe, expect, test } from "vitest";
import type { HostProjectListItem } from "./host-project-model";
import {
  canCreateWorkspaceForHostProject,
  getHostProjectId,
  getHostProjectSourceDirectory,
  getWorktreeSupportForHostProject,
  hostProjectFromRoute,
  hostProjectFromWorkspace,
  resolveEquivalentHostProjectCandidate,
} from "./host-project-model";
import { normalizeWorkspaceDescriptor } from "@/stores/session-store";

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
  test("resolves equivalent projects without Array.prototype.toSorted", () => {
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "toSorted");
    Reflect.deleteProperty(Array.prototype, "toSorted");
    const first = project();
    first.viewKey = "view:first";
    first.projectName = "First";
    const second = project();
    second.viewKey = "view:second";
    second.projectName = "Second";
    const projects = [second, first];

    try {
      expect(
        resolveEquivalentHostProjectCandidate({
          candidate: first,
          projects,
          serverId: "host-a",
        }),
      ).toBe(first);
      expect(projects).toEqual([second, first]);
    } finally {
      if (descriptor) Reflect.defineProperty(Array.prototype, "toSorted", descriptor);
    }
  });

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

  test("keeps canonical equivalence identity separate from host placement identity", () => {
    const workspace = normalizeWorkspaceDescriptor({
      id: "workspace-a",
      projectId: "project-a",
      projectDisplayName: "App",
      projectRootPath: "/repo/app",
      workspaceDirectory: "/repo/app",
      projectKind: "git",
      workspaceKind: "local_checkout",
      name: "main",
      archivingAt: null,
      status: "done",
      statusEnteredAt: null,
      activityAt: null,
      diffStat: null,
      scripts: [],
      project: {
        projectKey: "remote:github.com/acme/app",
        projectName: "App",
        checkout: {
          cwd: "/repo/app",
          isGit: true,
          currentBranch: "main",
          remoteUrl: "https://github.com/acme/app.git",
          worktreeRoot: "/repo/app",
          isPaseoOwnedWorktree: false,
          mainRepoRoot: null,
        },
      },
    });

    expect(hostProjectFromWorkspace({ serverId: "host-a", workspace })).toMatchObject({
      viewKey: JSON.stringify(["host-a", "project-a"]),
      projectKey: "remote:github.com/acme/app",
      hosts: [{ serverId: "host-a", projectId: "project-a" }],
    });
  });
});
