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
    createdAt: null,
    lastUserMessageAt: null,
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

test("sorts by creation or human prompt without changing picker name order", () => {
  const old = {
    ...workspace("old", "p", "/p"),
    name: "A",
    createdAt: new Date("2026-01-01"),
    lastUserMessageAt: new Date("2026-03-01"),
  };
  const fresh = {
    ...workspace("fresh", "p", "/p"),
    name: "B",
    createdAt: new Date("2026-02-01"),
    lastUserMessageAt: null,
  };
  const sessions = [
    {
      serverId: "host",
      projects: [project({ id: "p", key: "p", root: "/p" })],
      workspaces: [old, fresh],
    },
  ];
  expect(
    buildWorkspaceStructureProjects({ sessions, workspaceSort: "created" })[0].workspaceKeys,
  ).toEqual(["host:fresh", "host:old"]);
  expect(
    buildWorkspaceStructureProjects({ sessions, workspaceSort: "lastPrompt" })[0].workspaceKeys,
  ).toEqual(["host:old", "host:fresh"]);
  expect(buildWorkspaceStructureProjects({ sessions })[0].workspaceKeys).toEqual([
    "host:old",
    "host:fresh",
  ]);
});

test("time ties use workspace identity so renaming cannot move Created rows", () => {
  const a = { ...workspace("a", "p", "/p"), name: "Z", createdAt: new Date("2026-01-01") };
  const b = { ...workspace("b", "p", "/p"), name: "A", createdAt: a.createdAt };
  const sessions = [
    { serverId: "h", projects: [project({ id: "p", key: "p", root: "/p" })], workspaces: [b, a] },
  ];
  expect(
    buildWorkspaceStructureProjects({ sessions, workspaceSort: "created" })[0].workspaceKeys,
  ).toEqual(["h:a", "h:b"]);
  a.name = "A";
  b.name = "Z";
  expect(
    buildWorkspaceStructureProjects({ sessions, workspaceSort: "created" })[0].workspaceKeys,
  ).toEqual(["h:a", "h:b"]);
});

test("automatic sorts order project sections by their most recent workspace", () => {
  const stale = project({ id: "stale", key: "stale", root: "/stale", name: "stale" });
  const fresh = project({ id: "fresh", key: "fresh", root: "/fresh", name: "fresh" });
  const sessions = [
    {
      serverId: "h",
      projects: [stale, fresh],
      workspaces: [
        {
          ...workspace("ws-stale", "stale", "/stale"),
          createdAt: new Date("2026-01-01"),
          lastUserMessageAt: new Date("2026-01-02"),
        },
        {
          ...workspace("ws-fresh", "fresh", "/fresh"),
          createdAt: new Date("2026-02-01"),
          lastUserMessageAt: new Date("2026-03-01"),
        },
      ],
    },
  ];

  expect(
    buildWorkspaceStructureProjects({ sessions, workspaceSort: "lastPrompt" }).map(
      (item) => item.viewKey,
    ),
  ).toEqual(["fresh", "stale"]);
  expect(
    buildWorkspaceStructureProjects({ sessions, workspaceSort: "created" }).map(
      (item) => item.viewKey,
    ),
  ).toEqual(["fresh", "stale"]);

  // Once a project's workspace was prompted more recently, the sections follow.
  sessions[0].workspaces = [sessions[0].workspaces[0]];
  sessions[0].workspaces[0].lastUserMessageAt = new Date("2026-04-01");
  expect(
    buildWorkspaceStructureProjects({ sessions, workspaceSort: "lastPrompt" }).map(
      (item) => item.viewKey,
    ),
  ).toEqual(["stale", "fresh"]);
});

test("projects without workspaces keep name order below prompted ones", () => {
  const empty = project({ id: "empty", key: "empty", root: "/empty", name: "aaa-empty" });
  const idle = project({ id: "idle", key: "idle", root: "/idle", name: "zzz-idle" });
  const sessions = [
    {
      serverId: "h",
      projects: [empty, idle],
      workspaces: [{ ...workspace("ws-idle", "idle", "/idle"), createdAt: new Date("2026-01-01") }],
    },
  ];

  expect(
    buildWorkspaceStructureProjects({ sessions, workspaceSort: "created" }).map(
      (item) => item.viewKey,
    ),
  ).toEqual(["idle", "empty"]);
  expect(buildWorkspaceStructureProjects({ sessions }).map((item) => item.viewKey)).toEqual([
    "empty",
    "idle",
  ]);
});

test("manual sort keeps name order for project sections", () => {
  const zeta = project({ id: "zeta", key: "zeta", root: "/zeta", name: "zeta" });
  const alpha = project({ id: "alpha", key: "alpha", root: "/alpha", name: "alpha" });
  const sessions = [
    {
      serverId: "h",
      projects: [zeta, alpha],
      workspaces: [
        { ...workspace("ws-zeta", "zeta", "/zeta"), createdAt: new Date("2026-02-01") },
        { ...workspace("ws-alpha", "alpha", "/alpha"), createdAt: new Date("2026-01-01") },
      ],
    },
  ];

  expect(
    buildWorkspaceStructureProjects({ sessions, workspaceSort: "manual" }).map(
      (item) => item.viewKey,
    ),
  ).toEqual(["alpha", "zeta"]);
});
