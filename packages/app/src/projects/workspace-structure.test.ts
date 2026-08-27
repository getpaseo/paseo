import { describe, expect, test } from "vitest";
import type { ProjectDescriptor, WorkspaceDescriptor } from "@/stores/session-store";
import { buildWorkspaceStructureProjects, createProjectViewKey } from "./workspace-structure";

function project(input: {
  id: string;
  key: string | null;
  root: string;
  name?: string;
}): ProjectDescriptor {
  return {
    projectId: input.id,
    projectKey: input.key,
    projectDisplayName: input.name ?? "acme/app",
    projectCustomName: null,
    projectRootPath: input.root,
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

describe("buildWorkspaceStructureProjects", () => {
  test("groups the same project key across hosts and keeps host-local ids", () => {
    const key = "remote:github.com/acme/app";
    const result = buildWorkspaceStructureProjects({
      sessions: [
        {
          serverId: "host-a",
          projects: [project({ id: "prj_a", key, root: "/a/app" })],
          workspaces: [workspace("ws-a", "prj_a", "/a/app")],
        },
        {
          serverId: "host-b",
          projects: [project({ id: "prj_b", key, root: "/b/app" })],
          workspaces: [workspace("ws-b", "prj_b", "/b/app")],
        },
      ],
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      viewKey: key,
      projectKey: key,
      hosts: [
        { serverId: "host-a", projectId: "prj_a" },
        { serverId: "host-b", projectId: "prj_b" },
      ],
      workspaceKeys: ["host-a:ws-a", "host-b:ws-b"],
    });
  });

  test("keeps two clones with the same key on one host separate", () => {
    const key = "remote:github.com/acme/app";
    const result = buildWorkspaceStructureProjects({
      sessions: [
        {
          serverId: "host-a",
          projects: [
            project({ id: "prj_one", key, root: "/repos/one" }),
            project({ id: "prj_two", key, root: "/repos/two" }),
          ],
          workspaces: [
            workspace("ws-one", "prj_one", "/repos/one"),
            workspace("ws-two", "prj_two", "/repos/two"),
          ],
        },
      ],
    });

    expect(result).toHaveLength(2);
    expect(result.map((item) => item.projectKey)).toEqual([key, key]);
    expect(result.map((item) => item.hosts[0]?.projectId).sort()).toEqual(["prj_one", "prj_two"]);
    expect(result.map((item) => item.workspaceKeys[0]).sort()).toEqual([
      "host-a:ws-one",
      "host-a:ws-two",
    ]);
  });

  test("does not let project order choose which same-host clone groups with another host", () => {
    const key = "remote:github.com/acme/app";
    const hostAProjects = [
      project({ id: "prj_one", key, root: "/repos/one" }),
      project({ id: "prj_two", key, root: "/repos/two" }),
    ];
    const build = (projects: ProjectDescriptor[]) =>
      buildWorkspaceStructureProjects({
        sessions: [
          { serverId: "host-a", projects, workspaces: [] },
          {
            serverId: "host-b",
            projects: [project({ id: "prj_remote", key, root: "/repos/remote" })],
            workspaces: [],
          },
        ],
      });
    const identitiesByProjectId = (projects: ReturnType<typeof build>) => {
      const identities: Record<string, string> = {};
      for (const group of projects) {
        for (const host of group.hosts) identities[host.projectId] = group.viewKey;
      }
      return identities;
    };

    const forward = build(hostAProjects);
    const reversed = build(hostAProjects.toReversed());

    expect(forward).toHaveLength(3);
    expect(identitiesByProjectId(forward)).toEqual(identitiesByProjectId(reversed));
    expect(new Set(Object.values(identitiesByProjectId(forward))).size).toBe(3);
  });

  test("keeps projects without persisted keys scoped to their host", () => {
    const result = buildWorkspaceStructureProjects({
      sessions: [
        {
          serverId: "host-a",
          projects: [project({ id: "/workspace/app", key: null, root: "/workspace/app" })],
          workspaces: [],
        },
        {
          serverId: "host-b",
          projects: [project({ id: "/workspace/app", key: null, root: "/workspace/app" })],
          workspaces: [],
        },
      ],
    });

    expect(result).toHaveLength(2);
    expect(result.map((item) => item.projectKey)).toEqual([null, null]);
    expect(new Set(result.map((item) => item.viewKey)).size).toBe(2);
  });

  test("keeps opaque project keys separate from placement view keys", () => {
    const placementShapedKey = createProjectViewKey({
      kind: "placement",
      serverId: "host-a",
      projectId: "prj_b",
    });
    const result = buildWorkspaceStructureProjects({
      sessions: [
        {
          serverId: "host-a",
          projects: [
            project({ id: "prj_a", key: placementShapedKey, root: "/repos/a" }),
            project({ id: "prj_b", key: null, root: "/repos/b" }),
          ],
          workspaces: [],
        },
      ],
    });

    expect(result).toHaveLength(2);
    expect(new Set(result.map((item) => item.viewKey)).size).toBe(2);
    expect(result.find((item) => item.projectKey === placementShapedKey)?.viewKey).toBe(
      placementShapedKey,
    );
  });
});
