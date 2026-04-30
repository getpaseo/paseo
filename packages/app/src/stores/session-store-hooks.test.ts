/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { DaemonClient } from "@server/client/daemon-client";
import {
  useHasWorkspaces,
  useRecommendedProjectPaths,
  useResolveWorkspaceIdByCwd,
  useWorkspace,
  useWorkspaceExecutionAuthority,
  useWorkspaceFields,
  useWorkspaceKeys,
  useWorkspaceStatusesForBadges,
  useWorkspaceStructure,
} from "./session-store-hooks";
import { useSidebarOrderStore } from "./sidebar-order-store";
import { useSessionStore, type WorkspaceDescriptor } from "./session-store";

const SERVER_ID = "test-server";

function createWorkspace(
  input: Partial<WorkspaceDescriptor> & Pick<WorkspaceDescriptor, "id">,
): WorkspaceDescriptor {
  return {
    id: input.id,
    projectId: input.projectId ?? "project-1",
    projectDisplayName: input.projectDisplayName ?? "Project 1",
    projectRootPath: input.projectRootPath ?? "/repo",
    workspaceDirectory: input.workspaceDirectory ?? "/repo",
    projectKind: input.projectKind ?? "git",
    workspaceKind: input.workspaceKind ?? "local_checkout",
    name: input.name ?? "main",
    status: input.status ?? "done",
    archivingAt: input.archivingAt ?? null,
    diffStat: input.diffStat ?? null,
    scripts: input.scripts ?? [],
  };
}

function initializeWorkspaces(workspaces: WorkspaceDescriptor[]): void {
  act(() => {
    useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
    useSessionStore
      .getState()
      .setWorkspaces(SERVER_ID, new Map(workspaces.map((workspace) => [workspace.id, workspace])));
  });
}

afterEach(() => {
  act(() => {
    useSessionStore.getState().clearSession(SERVER_ID);
    useSidebarOrderStore.setState({
      projectOrderByServerId: {},
      workspaceOrderByServerAndProject: {},
    });
  });
});

describe("useWorkspace", () => {
  it("resolves a descriptor when the route id matches workspace identity but not the map key", () => {
    const workspace = createWorkspace({ id: "workspace-a" });
    act(() => {
      useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
      useSessionStore.getState().setWorkspaces(SERVER_ID, new Map([["map-key-a", workspace]]));
    });

    const { result } = renderHook(() => useWorkspace(SERVER_ID, workspace.id));

    expect(result.current).toBe(workspace);
  });

  it("keeps the descriptor reference for unrelated workspace updates", () => {
    const workspaceA = createWorkspace({ id: "workspace-a", name: "A" });
    const workspaceB = createWorkspace({ id: "workspace-b", name: "B" });
    initializeWorkspaces([workspaceA, workspaceB]);

    const { result } = renderHook(() => useWorkspace(SERVER_ID, workspaceA.id));
    const before = result.current;

    act(() => {
      useSessionStore.getState().mergeWorkspaces(SERVER_ID, [{ ...workspaceB, status: "running" }]);
    });
    expect(result.current).toBe(before);

    act(() => {
      useSessionStore
        .getState()
        .mergeWorkspaces(SERVER_ID, [{ ...workspaceA, status: "attention" }]);
    });
    expect(result.current).not.toBe(before);
  });

  it("keeps the descriptor reference when the observed workspace is rewritten with content-equal data", () => {
    const workspace = createWorkspace({ id: "workspace-a", scripts: [] });
    initializeWorkspaces([workspace]);

    const { result } = renderHook(() => useWorkspace(SERVER_ID, workspace.id));
    const before = result.current;

    act(() => {
      useSessionStore
        .getState()
        .setWorkspaces(SERVER_ID, new Map([[workspace.id, { ...workspace, scripts: [] }]]));
    });
    expect(result.current).toBe(before);
  });
});

describe("useWorkspaceExecutionAuthority", () => {
  it("preserves the old missing-workspace message with the requested id", () => {
    initializeWorkspaces([]);

    const { result } = renderHook(() => useWorkspaceExecutionAuthority(SERVER_ID, "missing-id"));

    expect(result.current).toMatchObject({
      ok: false,
      message: "Workspace not found: missing-id",
    });
  });

  it("keeps deep-equal authority references under unrelated workspace updates", () => {
    const workspaceA = createWorkspace({ id: "workspace-a", name: "A" });
    const workspaceB = createWorkspace({ id: "workspace-b", name: "B" });
    initializeWorkspaces([workspaceA, workspaceB]);

    const { result } = renderHook(() => useWorkspaceExecutionAuthority(SERVER_ID, workspaceA.id));
    const before = result.current;

    act(() => {
      useSessionStore.getState().mergeWorkspaces(SERVER_ID, [{ ...workspaceB, status: "running" }]);
    });

    expect(result.current).toBe(before);
  });
});

describe("useWorkspaceFields", () => {
  it("keeps deep-equal projection references until projected fields change", () => {
    const workspace = createWorkspace({ id: "workspace-a", name: "A", status: "done" });
    initializeWorkspaces([workspace]);

    const selectIdentity = (current: { id: string; name: string }) => ({
      identity: {
        id: current.id,
        name: current.name,
      },
    });
    const { result } = renderHook(() =>
      useWorkspaceFields(SERVER_ID, workspace.id, selectIdentity),
    );
    const before = result.current;

    act(() => {
      useSessionStore.getState().mergeWorkspaces(SERVER_ID, [{ ...workspace, status: "running" }]);
    });
    expect(result.current).toBe(before);

    act(() => {
      useSessionStore.getState().mergeWorkspaces(SERVER_ID, [
        {
          ...workspace,
          name: "A renamed",
          status: "running",
        },
      ]);
    });
    expect(result.current).not.toBe(before);
  });
});

describe("useWorkspaceStructure", () => {
  it("changes for membership updates but not status-only updates", () => {
    const workspaceA = createWorkspace({ id: "workspace-a", name: "A" });
    const workspaceB = createWorkspace({ id: "workspace-b", name: "B" });
    initializeWorkspaces([workspaceA]);

    const { result } = renderHook(() => useWorkspaceStructure(SERVER_ID));
    const before = result.current;

    act(() => {
      useSessionStore.getState().mergeWorkspaces(SERVER_ID, [workspaceB]);
    });
    const afterAdd = result.current;
    expect(afterAdd).not.toBe(before);
    expect(afterAdd.projects[0]?.workspaceKeys).toEqual(["workspace-a", "workspace-b"]);

    act(() => {
      useSessionStore.getState().mergeWorkspaces(SERVER_ID, [{ ...workspaceA, status: "running" }]);
    });
    expect(result.current).toBe(afterAdd);
  });

  it("changes when a structure-relevant project identity field changes", () => {
    const workspace = createWorkspace({
      id: "workspace-a",
      projectDisplayName: "Project 1",
    });
    initializeWorkspaces([workspace]);

    const { result } = renderHook(() => useWorkspaceStructure(SERVER_ID));
    const before = result.current;

    act(() => {
      useSessionStore
        .getState()
        .mergeWorkspaces(SERVER_ID, [{ ...workspace, projectDisplayName: "Project Renamed" }]);
    });
    expect(result.current).not.toBe(before);
  });

  it("changes when persisted sidebar project order changes", () => {
    const workspaceA = createWorkspace({
      id: "workspace-a",
      projectId: "project-a",
      projectDisplayName: "Project A",
    });
    const workspaceB = createWorkspace({
      id: "workspace-b",
      projectId: "project-b",
      projectDisplayName: "Project B",
    });
    initializeWorkspaces([workspaceA, workspaceB]);

    const { result } = renderHook(() => useWorkspaceStructure(SERVER_ID));
    const before = result.current;

    act(() => {
      useSidebarOrderStore.getState().setProjectOrder(SERVER_ID, ["project-b", "project-a"]);
    });
    expect(result.current).not.toBe(before);
  });
});

describe("useWorkspaceKeys", () => {
  it("changes for reorder updates but not content-only updates", () => {
    const workspaceA = createWorkspace({ id: "workspace-a", name: "A" });
    const workspaceB = createWorkspace({ id: "workspace-b", name: "B" });
    initializeWorkspaces([workspaceA, workspaceB]);

    const { result } = renderHook(() => useWorkspaceKeys(SERVER_ID));
    const before = result.current;
    expect(before).toEqual(["workspace-a", "workspace-b"]);

    act(() => {
      useSessionStore.getState().setWorkspaces(
        SERVER_ID,
        new Map([
          [workspaceB.id, workspaceB],
          [workspaceA.id, workspaceA],
        ]),
      );
    });
    const afterReorder = result.current;
    expect(afterReorder).not.toBe(before);
    expect(afterReorder).toEqual(["workspace-b", "workspace-a"]);

    act(() => {
      useSessionStore.getState().mergeWorkspaces(SERVER_ID, [{ ...workspaceA, status: "running" }]);
    });
    expect(result.current).toBe(afterReorder);
  });
});

describe("useRecommendedProjectPaths", () => {
  it("updates when an existing workspace project root changes", () => {
    const workspace = createWorkspace({ id: "workspace-a", projectRootPath: "/repo/a" });
    initializeWorkspaces([workspace]);

    const { result } = renderHook(() => useRecommendedProjectPaths(SERVER_ID));

    act(() => {
      useSessionStore
        .getState()
        .mergeWorkspaces(SERVER_ID, [{ ...workspace, projectRootPath: "/repo/b" }]);
    });

    expect(result.current).toEqual(["/repo/b"]);
  });

  it("keeps the path list reference under unrelated workspace updates", () => {
    const workspace = createWorkspace({ id: "workspace-a", projectRootPath: "/repo/a" });
    initializeWorkspaces([workspace]);

    const { result } = renderHook(() => useRecommendedProjectPaths(SERVER_ID));
    const before = result.current;

    act(() => {
      useSessionStore.getState().mergeWorkspaces(SERVER_ID, [{ ...workspace, status: "running" }]);
    });

    expect(result.current).toBe(before);
  });
});

describe("useHasWorkspaces", () => {
  it("stays stable when workspace membership changes without flipping the boolean", () => {
    const workspaceA = createWorkspace({ id: "workspace-a" });
    const workspaceB = createWorkspace({ id: "workspace-b" });
    initializeWorkspaces([workspaceA]);

    const { result } = renderHook(() => useHasWorkspaces(SERVER_ID));
    const before = result.current;

    act(() => {
      useSessionStore.getState().mergeWorkspaces(SERVER_ID, [workspaceB]);
    });

    expect(result.current).toBe(before);
  });
});

describe("useResolveWorkspaceIdByCwd", () => {
  it("resolves by cwd and stays stable under unrelated updates", () => {
    const workspaceA = createWorkspace({
      id: "workspace-a",
      workspaceDirectory: "/repo/a",
    });
    const workspaceB = createWorkspace({
      id: "workspace-b",
      workspaceDirectory: "/repo/b",
    });
    initializeWorkspaces([workspaceA, workspaceB]);

    const { result } = renderHook(() => useResolveWorkspaceIdByCwd(SERVER_ID, "/repo/a"));
    const before = result.current;
    expect(before).toBe("workspace-a");

    act(() => {
      useSessionStore.getState().mergeWorkspaces(SERVER_ID, [{ ...workspaceB, status: "running" }]);
    });
    expect(result.current).toBe(before);
  });
});

describe("useWorkspaceStatusesForBadges", () => {
  it("tracks status changes without changing for no-ops or unrelated descriptor updates", () => {
    const workspaceA = createWorkspace({ id: "workspace-a", status: "done" });
    const workspaceB = createWorkspace({ id: "workspace-b", status: "attention" });
    initializeWorkspaces([workspaceA, workspaceB]);

    const { result } = renderHook(() => useWorkspaceStatusesForBadges());
    const before = result.current;
    expect(before).toEqual(["done", "attention"]);

    act(() => {
      useSessionStore
        .getState()
        .mergeWorkspaces(SERVER_ID, [{ ...workspaceA, scripts: [...workspaceA.scripts] }]);
    });
    expect(result.current).toBe(before);

    act(() => {
      useSessionStore.getState().mergeWorkspaces(SERVER_ID, [{ ...workspaceB, name: "Renamed" }]);
    });
    expect(result.current).toBe(before);

    act(() => {
      useSessionStore.getState().mergeWorkspaces(SERVER_ID, [{ ...workspaceA, status: "failed" }]);
    });
    expect(result.current).not.toBe(before);
    expect(result.current).toEqual(["failed", "attention"]);
  });
});
