import { describe, expect, test } from "vitest";
import { createProjectViewKey } from "@/projects/workspace-structure";
import type { ProjectDescriptor, WorkspaceDescriptor } from "@/stores/session-store";
import { buildProjects, getProjectSummaryForHostProject } from "./projects";

function descriptor(id: string, key: string, root: string): ProjectDescriptor {
  return {
    projectId: id,
    projectKey: key,
    projectDisplayName: "acme/app",
    projectCustomName: null,
    projectRootPath: root,
    projectKind: "git",
  };
}

function workspace(id: string, projectId: string, root: string): WorkspaceDescriptor {
  return {
    id,
    projectId,
    projectDisplayName: "acme/app",
    projectCustomName: null,
    projectRootPath: root,
    workspaceDirectory: root,
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "main",
    status: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };
}

describe("buildProjects", () => {
  test("uses the grouped project list while retaining each host project id", () => {
    const key = "remote:github.com/acme/app";
    const result = buildProjects({
      hosts: [
        {
          serverId: "host-a",
          serverName: "Host A",
          isOnline: true,
          projects: [descriptor("prj_a", key, "/a/app")],
          workspaces: [workspace("ws-a", "prj_a", "/a/app")],
        },
        {
          serverId: "host-b",
          serverName: "Host B",
          isOnline: false,
          projects: [descriptor("prj_b", key, "/b/app")],
          workspaces: [workspace("ws-b", "prj_b", "/b/app")],
        },
      ],
    });

    expect(result.projects).toEqual([
      expect.objectContaining({
        viewKey: createProjectViewKey({ kind: "equivalence", projectKey: key }),
        hostCount: 2,
        onlineHostCount: 1,
        totalWorkspaceCount: 2,
        hosts: [
          expect.objectContaining({ serverId: "host-a", projectId: "prj_a" }),
          expect.objectContaining({ serverId: "host-b", projectId: "prj_b" }),
        ],
      }),
    ]);
  });

  test("includes a project with no workspaces", () => {
    const result = buildProjects({
      hosts: [
        {
          serverId: "host-a",
          serverName: "Host A",
          isOnline: true,
          projects: [descriptor("prj_a", "local-a", "/a/app")],
          workspaces: [],
        },
      ],
    });

    expect(result.projects[0]).toMatchObject({
      totalWorkspaceCount: 0,
      hosts: [{ projectId: "prj_a", repoRoot: "/a/app" }],
    });
  });

  test("looks up a grouped project by host-local identity", () => {
    const project = buildProjects({
      hosts: [
        {
          serverId: "host-a",
          serverName: "Host A",
          isOnline: true,
          projects: [descriptor("prj_a", "shared", "/a/app")],
          workspaces: [],
        },
      ],
    }).projects[0];

    expect(getProjectSummaryForHostProject(project ? [project] : [], "host-a", "prj_a")).toBe(
      project,
    );
  });
});
