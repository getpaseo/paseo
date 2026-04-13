import { describe, expect, it } from "vitest";
import {
  appendMissingOrderKeys,
  applyStoredOrdering,
  buildSidebarProjectsFromWorkspaces,
} from "./use-sidebar-workspaces-list";
import type { WorkspaceDescriptor } from "@/stores/session-store";

interface OrderedItem {
  key: string;
}

function item(key: string): OrderedItem {
  return { key };
}

function workspace(
  input: Pick<WorkspaceDescriptor, "id" | "projectId" | "name" | "status"> &
    Partial<
      Pick<
        WorkspaceDescriptor,
        "projectDisplayName" | "projectRootPath" | "projectKind" | "workspaceKind"
      >
    >,
): WorkspaceDescriptor {
  return {
    id: input.id,
    projectId: input.projectId,
    projectDisplayName: input.projectDisplayName ?? input.projectId,
    projectRootPath: input.projectRootPath ?? input.id,
    projectKind: input.projectKind ?? "git",
    workspaceKind: input.workspaceKind ?? "local_checkout",
    name: input.name,
    status: input.status,
    diffStat: null,
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

describe("buildSidebarProjectsFromWorkspaces", () => {
  it("uses workspace descriptor name and status directly", () => {
    const workspaces: WorkspaceDescriptor[] = [
      workspace({
        id: "/repo/main",
        projectId: "project-1",
        name: "feat/hard-cut",
        status: "failed",
      }),
    ];

    const projects = buildSidebarProjectsFromWorkspaces({
      serverId: "srv",
      workspaces,
      projectOrder: [],
      workspaceOrderByScope: {},
    });

    expect(projects).toHaveLength(1);
    expect(projects[0]?.statusBucket).toBe("failed");
    expect(projects[0]?.workspaces[0]?.name).toBe("feat/hard-cut");
    expect(projects[0]?.workspaces[0]?.statusBucket).toBe("failed");
  });

  it("preserves stored project order even when input order differs", () => {
    const initialWorkspaces: WorkspaceDescriptor[] = [
      workspace({
        id: "/repo/b",
        projectId: "project-b",
        name: "feat/b",
        status: "running",
      }),
      workspace({
        id: "/repo/a",
        projectId: "project-a",
        name: "feat/a",
        status: "running",
      }),
    ];

    const seededOrder = appendMissingOrderKeys({
      currentOrder: [],
      visibleKeys: buildSidebarProjectsFromWorkspaces({
        serverId: "srv",
        workspaces: initialWorkspaces,
        projectOrder: [],
        workspaceOrderByScope: {},
      }).map((project) => project.projectKey),
    });

    const updatedProjects = buildSidebarProjectsFromWorkspaces({
      serverId: "srv",
      workspaces: [
        workspace({
          id: "/repo/a",
          projectId: "project-a",
          name: "feat/a",
          status: "running",
        }),
        workspace({
          id: "/repo/b",
          projectId: "project-b",
          name: "feat/b",
          status: "running",
        }),
      ],
      projectOrder: seededOrder,
      workspaceOrderByScope: {},
    });

    expect(updatedProjects.map((project) => project.projectKey)).toEqual([
      "project-a",
      "project-b",
    ]);
  });

  it("appends new projects after the stored project order", () => {
    const projects = buildSidebarProjectsFromWorkspaces({
      serverId: "srv",
      workspaces: [
        workspace({
          id: "/repo/c",
          projectId: "project-c",
          name: "feat/c",
          status: "running",
        }),
        workspace({
          id: "/repo/b",
          projectId: "project-b",
          name: "feat/b",
          status: "running",
        }),
        workspace({
          id: "/repo/a",
          projectId: "project-a",
          name: "feat/a",
          status: "running",
        }),
      ],
      projectOrder: ["project-b", "project-a", "project-c"],
      workspaceOrderByScope: {},
    });

    expect(projects.map((project) => project.projectKey)).toEqual([
      "project-b",
      "project-a",
      "project-c",
    ]);
  });

  it("preserves stored workspace order when workspace activity changes", () => {
    const initialProjects = buildSidebarProjectsFromWorkspaces({
      serverId: "srv",
      workspaces: [
        workspace({
          id: "/repo/main",
          projectId: "project-1",
          name: "main",
          status: "running",
        }),
        workspace({
          id: "/repo/feature",
          projectId: "project-1",
          name: "feature",
          status: "running",
        }),
      ],
      projectOrder: ["project-1"],
      workspaceOrderByScope: {},
    });

    const seededWorkspaceOrder = appendMissingOrderKeys({
      currentOrder: [],
      visibleKeys: initialProjects[0]?.workspaces.map((workspace) => workspace.workspaceKey) ?? [],
    });

    const projects = buildSidebarProjectsFromWorkspaces({
      serverId: "srv",
      workspaces: [
        workspace({
          id: "/repo/main",
          projectId: "project-1",
          name: "main",
          status: "running",
        }),
        workspace({
          id: "/repo/feature",
          projectId: "project-1",
          name: "feature",
          status: "running",
        }),
      ],
      projectOrder: ["project-1"],
      workspaceOrderByScope: {
        "srv::project-1": seededWorkspaceOrder,
      },
    });

    expect(projects[0]?.workspaces.map((workspace) => workspace.workspaceId)).toEqual([
      "/repo/feature",
      "/repo/main",
    ]);
  });
});
