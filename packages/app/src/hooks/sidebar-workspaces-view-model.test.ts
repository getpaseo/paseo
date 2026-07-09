import { describe, expect, it } from "vitest";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import type { WorkspaceStructureProject } from "@/projects/workspace-structure";
import {
  appendMissingOrderKeys,
  applyStoredOrdering,
  buildSidebarStatusWorkspacePlacements,
  buildSidebarWorkspacePlacementModel,
  buildSidebarProjectsFromStructure,
  computeSidebarOrderUpdates,
  deriveSidebarLoadingState,
  shouldShowSidebarHostLabels,
  type SidebarProjectEntry,
} from "./sidebar-workspaces-view-model";

interface OrderedItem {
  key: string;
}

function item(key: string): OrderedItem {
  return { key };
}

function project(input: {
  projectKey: string;
  projectName?: string;
  projectKind?: WorkspaceStructureProject["projectKind"];
  iconWorkingDir?: string;
  workspaceKeys: string[];
  hosts?: WorkspaceStructureProject["hosts"];
}): WorkspaceStructureProject {
  return {
    projectKey: input.projectKey,
    projectName: input.projectName ?? input.projectKey,
    projectKind: input.projectKind ?? "git",
    iconWorkingDir: input.iconWorkingDir ?? input.projectKey,
    hosts: input.hosts ?? [
      {
        serverId: "srv",
        iconWorkingDir: input.iconWorkingDir ?? input.projectKey,
        canCreateWorktree: true,
      },
    ],
    workspaceKeys: input.workspaceKeys,
  };
}

function sidebarProject(input: {
  projectKey: string;
  workspaceKeys: string[];
}): SidebarProjectEntry {
  const projects = buildSidebarProjectsFromStructure({
    projects: [project({ projectKey: input.projectKey, workspaceKeys: input.workspaceKeys })],
  });
  const result = projects[0];
  if (!result) {
    throw new Error("expected a project entry");
  }
  return result;
}

function workspace(input: {
  id: string;
  name: string;
  projectId: string;
  projectDisplayName: string;
  status?: WorkspaceDescriptor["status"];
  statusEnteredAt?: Date | null;
}): WorkspaceDescriptor {
  return {
    id: input.id,
    projectId: input.projectId,
    projectDisplayName: input.projectDisplayName,
    projectRootPath: `/repo/${input.projectId}`,
    workspaceDirectory: `/repo/${input.projectId}/${input.id}`,
    projectKind: "git",
    workspaceKind: input.name === "main" ? "local_checkout" : "worktree",
    name: input.name,
    status: input.status ?? "done",
    statusEnteredAt: input.statusEnteredAt ?? null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };
}

describe("applyStoredOrdering", () => {
  it("keeps unknown items on the baseline while applying stored order", () => {
    const result = applyStoredOrdering({
      items: [item("new"), item("a"), item("b")],
      storedOrder: ["b", "a"],
      getKey: (entry) => entry.key,
    });

    expect(result.map((entry) => entry.key)).toEqual(["new", "b", "a"]);
  });

  it("ignores stale and duplicate stored keys", () => {
    const result = applyStoredOrdering({
      items: [item("x"), item("y")],
      storedOrder: ["missing", "y", "y", "x"],
      getKey: (entry) => entry.key,
    });

    expect(result.map((entry) => entry.key)).toEqual(["y", "x"]);
  });

  it("returns baseline when there is no persisted order", () => {
    const baseline = [item("first"), item("second")];
    const result = applyStoredOrdering({
      items: baseline,
      storedOrder: [],
      getKey: (entry) => entry.key,
    });

    expect(result).toBe(baseline);
  });
});

describe("appendMissingOrderKeys", () => {
  it("appends unseen keys while preserving existing order", () => {
    const result = appendMissingOrderKeys({
      currentOrder: ["project-b", "project-a"],
      visibleKeys: ["project-a", "project-b", "project-c"],
    });

    expect(result).toEqual(["project-b", "project-a", "project-c"]);
  });

  it("returns the same array when there are no unseen keys", () => {
    const currentOrder = ["project-a", "project-b"];

    const result = appendMissingOrderKeys({
      currentOrder,
      visibleKeys: ["project-b", "project-a"],
    });

    expect(result).toBe(currentOrder);
  });
});

describe("buildSidebarProjectsFromStructure", () => {
  it("creates structural workspace rows from ordered workspace keys", () => {
    const projects = buildSidebarProjectsFromStructure({
      projects: [
        project({
          projectKey: "project-1",
          projectName: "Project 1",
          iconWorkingDir: "/repo/main",
          workspaceKeys: ["ws-main"],
        }),
      ],
    });

    expect(projects).toHaveLength(1);
    expect(projects[0]?.projectName).toBe("Project 1");
    expect(projects[0]?.workspaces[0]).toMatchObject({
      workspaceKey: "srv:ws-main",
      serverId: "srv",
      workspaceId: "ws-main",
      projectRootPath: "/repo/main",
      projectKind: "git",
    });
  });

  it("preserves the structure hook project order", () => {
    const projects = buildSidebarProjectsFromStructure({
      projects: [
        project({ projectKey: "project-b", workspaceKeys: ["ws-b"] }),
        project({ projectKey: "project-a", workspaceKeys: ["ws-a"] }),
      ],
    });

    expect(projects.map((entry) => entry.projectKey)).toEqual(["project-b", "project-a"]);
  });

  it("preserves the structure hook workspace order", () => {
    const projects = buildSidebarProjectsFromStructure({
      projects: [project({ projectKey: "project-1", workspaceKeys: ["feature", "main"] })],
    });

    expect(projects[0]?.workspaces.map((placement) => placement.workspaceId)).toEqual([
      "feature",
      "main",
    ]);
  });

  it("resolves workspace keys by known host prefix when server ids contain colons", () => {
    const projects = buildSidebarProjectsFromStructure({
      projects: [
        project({
          projectKey: "project-1",
          hosts: [
            {
              serverId: "relay:paseo-host",
              iconWorkingDir: "/repo/project-1",
              canCreateWorktree: true,
            },
          ],
          workspaceKeys: ["relay:paseo-host:ws-main"],
        }),
      ],
    });

    expect(projects[0]?.workspaces[0]).toMatchObject({
      workspaceKey: "relay:paseo-host:ws-main",
      serverId: "relay:paseo-host",
      workspaceId: "ws-main",
    });
  });
});

describe("shared sidebar workspace model", () => {
  it("feeds project placement and status grouping from the same cross-host workspace identities", () => {
    const model = buildSidebarWorkspacePlacementModel({
      projects: [
        project({
          projectKey: "getpaseo/paseo",
          projectName: "getpaseo/paseo",
          iconWorkingDir: "/repo/getpaseo/paseo",
          hosts: [
            { serverId: "host-a", iconWorkingDir: "/repo/getpaseo/paseo", canCreateWorktree: true },
            { serverId: "host-b", iconWorkingDir: "/repo/getpaseo/paseo", canCreateWorktree: true },
          ],
          workspaceKeys: ["host-a:main", "host-b:feature"],
        }),
      ],
    });
    const statusRows = buildSidebarStatusWorkspacePlacements({
      placements: model.workspaces,
      sessions: [
        {
          serverId: "host-a",
          workspaceAgentActivity: new Map(),
          workspaces: new Map([
            [
              "main",
              workspace({
                id: "main",
                name: "main",
                projectId: "getpaseo/paseo",
                projectDisplayName: "getpaseo/paseo",
                status: "done",
              }),
            ],
          ]),
        },
        {
          serverId: "host-b",
          workspaceAgentActivity: new Map(),
          workspaces: new Map([
            [
              "feature",
              workspace({
                id: "feature",
                name: "feature/status-flow",
                projectId: "getpaseo/paseo",
                projectDisplayName: "getpaseo/paseo",
                status: "running",
                statusEnteredAt: new Date("2026-06-10T00:00:00.000Z"),
              }),
            ],
          ]),
        },
      ],
    });

    expect(model.workspaces.map((entry) => entry.workspaceKey)).toEqual([
      "host-a:main",
      "host-b:feature",
    ]);
    expect(model.projects).toEqual([
      expect.objectContaining({
        projectKey: "getpaseo/paseo",
        hosts: [
          { serverId: "host-a", iconWorkingDir: "/repo/getpaseo/paseo", canCreateWorktree: true },
          { serverId: "host-b", iconWorkingDir: "/repo/getpaseo/paseo", canCreateWorktree: true },
        ],
        workspaces: [
          expect.objectContaining({
            workspaceKey: "host-a:main",
            serverId: "host-a",
            name: "main",
          }),
          expect.objectContaining({
            workspaceKey: "host-b:feature",
            serverId: "host-b",
            name: "feature",
          }),
        ],
      }),
    ]);
    expect(statusRows.map((entry) => [entry.workspaceKey, entry.statusBucket, entry.name])).toEqual(
      [
        ["host-a:main", "done", "main"],
        ["host-b:feature", "running", "feature/status-flow"],
      ],
    );
    expect(model.projectNamesByKey).toEqual(new Map([["getpaseo/paseo", "getpaseo/paseo"]]));
  });
});

describe("shouldShowSidebarHostLabels", () => {
  it("is false with no visible projects", () => {
    expect(shouldShowSidebarHostLabels([])).toBe(false);
  });

  it("is false when every project lives on a single host", () => {
    const projects = buildSidebarProjectsFromStructure({
      projects: [
        project({ projectKey: "project-a", workspaceKeys: ["ws-1"] }),
        project({ projectKey: "project-b", workspaceKeys: ["ws-2"] }),
      ],
    });

    expect(shouldShowSidebarHostLabels(projects)).toBe(false);
  });

  it("is true when projects span separate hosts", () => {
    const projects = buildSidebarProjectsFromStructure({
      projects: [
        project({
          projectKey: "project-a",
          hosts: [
            { serverId: "host-a", iconWorkingDir: "/repo/project-a", canCreateWorktree: true },
          ],
          workspaceKeys: ["host-a:ws-1"],
        }),
        project({
          projectKey: "project-b",
          hosts: [
            { serverId: "host-b", iconWorkingDir: "/repo/project-b", canCreateWorktree: true },
          ],
          workspaceKeys: ["host-b:ws-2"],
        }),
      ],
    });

    expect(shouldShowSidebarHostLabels(projects)).toBe(true);
  });

  it("is true for a single project shared across hosts", () => {
    const projects = buildSidebarProjectsFromStructure({
      projects: [
        project({
          projectKey: "getpaseo/paseo",
          hosts: [
            { serverId: "host-a", iconWorkingDir: "/repo/paseo", canCreateWorktree: true },
            { serverId: "host-b", iconWorkingDir: "/repo/paseo", canCreateWorktree: true },
          ],
          workspaceKeys: ["host-a:main", "host-b:feature"],
        }),
      ],
    });

    expect(shouldShowSidebarHostLabels(projects)).toBe(true);
  });
});

describe("computeSidebarOrderUpdates", () => {
  it("returns no updates when there are no visible projects", () => {
    const updates = computeSidebarOrderUpdates({
      projects: [],
      persistedProjectOrder: ["stale-project"],
      getWorkspaceOrder: () => [],
    });

    expect(updates).toEqual({ projectOrder: null, workspaceOrders: [] });
  });

  it("appends unseen projects and workspaces to the persisted orders", () => {
    const projects = [
      sidebarProject({ projectKey: "project-a", workspaceKeys: ["ws-1", "ws-2"] }),
      sidebarProject({ projectKey: "project-b", workspaceKeys: ["ws-3"] }),
    ];

    const updates = computeSidebarOrderUpdates({
      projects,
      persistedProjectOrder: ["project-a"],
      getWorkspaceOrder: (projectKey) => (projectKey === "project-a" ? ["srv:ws-1"] : []),
    });

    expect(updates.projectOrder).toEqual(["project-a", "project-b"]);
    expect(updates.workspaceOrders).toEqual([
      { projectKey: "project-a", order: ["srv:ws-1", "srv:ws-2"] },
      { projectKey: "project-b", order: ["srv:ws-3"] },
    ]);
  });

  it("returns no project-order update when persisted order already covers visible keys", () => {
    const projects = [
      sidebarProject({ projectKey: "project-a", workspaceKeys: ["ws-1"] }),
      sidebarProject({ projectKey: "project-b", workspaceKeys: ["ws-2"] }),
    ];

    const updates = computeSidebarOrderUpdates({
      projects,
      persistedProjectOrder: ["project-b", "project-a"],
      getWorkspaceOrder: (projectKey) => (projectKey === "project-a" ? ["srv:ws-1"] : ["srv:ws-2"]),
    });

    expect(updates.projectOrder).toBeNull();
    expect(updates.workspaceOrders).toEqual([]);
  });
});

describe("deriveSidebarLoadingState", () => {
  it("reports initial-load while active and unhydrated with no projects", () => {
    expect(
      deriveSidebarLoadingState({
        isActive: true,
        serverIds: ["srv"],
        hydratedServerIds: [],
        hasProjects: false,
      }),
    ).toEqual({ isLoading: true, isInitialLoad: true, isRevalidating: false });
  });

  it("stays loading but not initial once projects are visible", () => {
    expect(
      deriveSidebarLoadingState({
        isActive: true,
        serverIds: ["srv"],
        hydratedServerIds: [],
        hasProjects: true,
      }),
    ).toEqual({ isLoading: true, isInitialLoad: false, isRevalidating: false });
  });

  it("clears loading once workspaces have hydrated", () => {
    expect(
      deriveSidebarLoadingState({
        isActive: true,
        serverIds: ["srv"],
        hydratedServerIds: ["srv"],
        hasProjects: true,
      }),
    ).toEqual({ isLoading: false, isInitialLoad: false, isRevalidating: false });
  });

  it("short-circuits to idle when inactive", () => {
    expect(
      deriveSidebarLoadingState({
        isActive: false,
        serverIds: ["srv"],
        hydratedServerIds: [],
        hasProjects: false,
      }),
    ).toEqual({ isLoading: false, isInitialLoad: false, isRevalidating: false });
  });
});
