import { afterEach, describe, expect, it } from "vitest";

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  composeWorkspaceStructure,
  selectHasWorkspaces,
  selectProjectOrder,
  selectRecommendedProjectPaths,
  selectResolveWorkspaceIdByCwd,
  selectWorkspace,
  selectWorkspaceDirectory,
  selectWorkspaceFields,
  selectWorkspaceKeys,
  selectWorkspaceOrderByScopeForServer,
  selectWorkspaceStatusesForBadges,
  selectWorkspaceStructureProjects,
  workspaceEqualityFns,
  type SidebarOrderSnapshot,
} from "./selectors";
import { useSessionStore, type WorkspaceDescriptor } from "../session-store";

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
    statusEnteredAt: null,
    diffStat: input.diffStat ?? null,
    scripts: input.scripts ?? [],
  };
}

function initializeWorkspaces(workspaces: WorkspaceDescriptor[]): void {
  useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
  useSessionStore
    .getState()
    .setWorkspaces(SERVER_ID, new Map(workspaces.map((workspace) => [workspace.id, workspace])));
}

interface Subscribable<S> {
  getState(): S;
  subscribe(listener: (state: S, prev: S) => void): () => void;
}

interface TrackedSelector<T> {
  readonly current: T;
  stop(): void;
}

// Mirrors what useStoreWithEqualityFn does: hold onto the previous selection and only
// publish a new value when the equality function rejects it. Lets tests assert reference
// stability without React or a DOM.
function trackSelector<S, T>(
  store: Subscribable<S>,
  select: (state: S) => T,
  eq: (a: T, b: T) => boolean,
): TrackedSelector<T> {
  let current = select(store.getState());
  const stop = store.subscribe((state) => {
    const candidate = select(state);
    if (!eq(candidate, current)) {
      current = candidate;
    }
  });
  return {
    get current() {
      return current;
    },
    stop,
  };
}

function emptySidebarOrder(): SidebarOrderSnapshot {
  return {
    projectOrderByServerId: {},
    workspaceOrderByServerAndProject: {},
  };
}

afterEach(() => {
  useSessionStore.getState().clearSession(SERVER_ID);
});

describe("selectWorkspace", () => {
  it("resolves a descriptor when the route id matches workspace identity but not the map key", () => {
    const workspace = createWorkspace({ id: "workspace-a" });
    useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
    useSessionStore.getState().setWorkspaces(SERVER_ID, new Map([["map-key-a", workspace]]));

    expect(selectWorkspace(useSessionStore.getState(), SERVER_ID, workspace.id)).toBe(workspace);
  });

  it("keeps the descriptor reference for unrelated workspace updates", () => {
    const workspaceA = createWorkspace({ id: "workspace-a", name: "A" });
    const workspaceB = createWorkspace({ id: "workspace-b", name: "B" });
    initializeWorkspaces([workspaceA, workspaceB]);

    const tracked = trackSelector(
      useSessionStore,
      (state) => selectWorkspace(state, SERVER_ID, workspaceA.id),
      workspaceEqualityFns.identity,
    );
    const before = tracked.current;

    useSessionStore.getState().mergeWorkspaces(SERVER_ID, [{ ...workspaceB, status: "running" }]);
    expect(tracked.current).toBe(before);

    useSessionStore.getState().mergeWorkspaces(SERVER_ID, [{ ...workspaceA, status: "attention" }]);
    expect(tracked.current).not.toBe(before);

    tracked.stop();
  });

  it("keeps the descriptor reference when the observed workspace is rewritten with content-equal data", () => {
    const workspace = createWorkspace({ id: "workspace-a", scripts: [] });
    initializeWorkspaces([workspace]);

    const tracked = trackSelector(
      useSessionStore,
      (state) => selectWorkspace(state, SERVER_ID, workspace.id),
      workspaceEqualityFns.identity,
    );
    const before = tracked.current;

    useSessionStore
      .getState()
      .setWorkspaces(SERVER_ID, new Map([[workspace.id, { ...workspace, scripts: [] }]]));
    expect(tracked.current).toBe(before);

    tracked.stop();
  });
});

describe("selectWorkspaceDirectory", () => {
  it("returns the workspace directory, never the opaque workspace id", () => {
    const workspace = createWorkspace({
      id: "wks_3f9a2b1c",
      workspaceDirectory: "/Users/dev/project",
    });
    initializeWorkspaces([workspace]);

    const directory = selectWorkspaceDirectory(
      useSessionStore.getState(),
      SERVER_ID,
      "wks_3f9a2b1c",
    );

    expect(directory).toBe("/Users/dev/project");
    expect(directory).not.toBe("wks_3f9a2b1c");
  });

  it("returns null when the workspace is missing", () => {
    initializeWorkspaces([]);

    expect(
      selectWorkspaceDirectory(useSessionStore.getState(), SERVER_ID, "missing-id"),
    ).toBeNull();
  });
});

describe("selectWorkspaceFields", () => {
  it("keeps deep-equal projection references until projected fields change", () => {
    const workspace = createWorkspace({ id: "workspace-a", name: "A", status: "done" });
    initializeWorkspaces([workspace]);

    const selectIdentity = (current: { id: string; name: string }) => ({
      identity: { id: current.id, name: current.name },
    });
    const tracked = trackSelector(
      useSessionStore,
      (state) => selectWorkspaceFields(state, SERVER_ID, workspace.id, selectIdentity),
      workspaceEqualityFns.deep,
    );
    const before = tracked.current;

    useSessionStore.getState().mergeWorkspaces(SERVER_ID, [{ ...workspace, status: "running" }]);
    expect(tracked.current).toBe(before);

    useSessionStore
      .getState()
      .mergeWorkspaces(SERVER_ID, [{ ...workspace, name: "A renamed", status: "running" }]);
    expect(tracked.current).not.toBe(before);

    tracked.stop();
  });
});

describe("workspace structure composition", () => {
  function snapshotStructure(
    serverId: string,
    sidebar: SidebarOrderSnapshot,
  ): ReturnType<typeof composeWorkspaceStructure> {
    return composeWorkspaceStructure({
      serverId,
      projects: selectWorkspaceStructureProjects(useSessionStore.getState(), serverId),
      projectOrder: selectProjectOrder(sidebar, serverId),
      workspaceOrderByScope: selectWorkspaceOrderByScopeForServer(sidebar, serverId),
    });
  }

  it("changes for membership updates but not status-only updates", () => {
    const workspaceA = createWorkspace({ id: "workspace-a", name: "A" });
    const workspaceB = createWorkspace({ id: "workspace-b", name: "B" });
    initializeWorkspaces([workspaceA]);

    const tracked = trackSelector(
      useSessionStore,
      (state) => selectWorkspaceStructureProjects(state, SERVER_ID),
      workspaceEqualityFns.deep,
    );
    const before = tracked.current;

    useSessionStore.getState().mergeWorkspaces(SERVER_ID, [workspaceB]);
    const afterAdd = tracked.current;
    expect(afterAdd).not.toBe(before);
    expect(afterAdd[0]?.workspaceKeys).toEqual(["workspace-a", "workspace-b"]);

    useSessionStore.getState().mergeWorkspaces(SERVER_ID, [{ ...workspaceA, status: "running" }]);
    expect(tracked.current).toBe(afterAdd);

    tracked.stop();
  });

  it("renders a project with zero active workspaces as an empty project parent", () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
    useSessionStore.getState().setWorkspaces(SERVER_ID, new Map());
    useSessionStore.getState().setEmptyProjects(SERVER_ID, [
      {
        projectId: "empty-project",
        projectDisplayName: "Empty Project",
        projectCustomName: null,
        projectRootPath: "/repo/empty",
        projectKind: "git",
      },
    ]);

    const projects = selectWorkspaceStructureProjects(useSessionStore.getState(), SERVER_ID);
    expect(projects).toEqual([
      expect.objectContaining({
        projectKey: "empty-project",
        projectName: "Empty Project",
        workspaceKeys: [],
      }),
    ]);
  });

  it("changes when a structure-relevant project identity field changes", () => {
    const workspace = createWorkspace({
      id: "workspace-a",
      projectDisplayName: "Project 1",
    });
    initializeWorkspaces([workspace]);

    const tracked = trackSelector(
      useSessionStore,
      (state) => selectWorkspaceStructureProjects(state, SERVER_ID),
      workspaceEqualityFns.deep,
    );
    const before = tracked.current;

    useSessionStore
      .getState()
      .mergeWorkspaces(SERVER_ID, [{ ...workspace, projectDisplayName: "Project Renamed" }]);
    expect(tracked.current).not.toBe(before);

    tracked.stop();
  });

  it("changes the composed structure when persisted sidebar project order changes", () => {
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

    const before = snapshotStructure(SERVER_ID, emptySidebarOrder());
    const after = snapshotStructure(SERVER_ID, {
      ...emptySidebarOrder(),
      projectOrderByServerId: { [SERVER_ID]: ["project-b", "project-a"] },
    });

    expect(after.projects.map((project) => project.projectKey)).toEqual(["project-b", "project-a"]);
    expect(after).not.toEqual(before);
  });
});

describe("selectWorkspaceKeys", () => {
  it("changes for reorder updates but not content-only updates", () => {
    const workspaceA = createWorkspace({ id: "workspace-a", name: "A" });
    const workspaceB = createWorkspace({ id: "workspace-b", name: "B" });
    initializeWorkspaces([workspaceA, workspaceB]);

    const tracked = trackSelector(
      useSessionStore,
      (state) => selectWorkspaceKeys(state, SERVER_ID),
      workspaceEqualityFns.deep,
    );
    const before = tracked.current;
    expect(before).toEqual(["workspace-a", "workspace-b"]);

    useSessionStore.getState().setWorkspaces(
      SERVER_ID,
      new Map([
        [workspaceB.id, workspaceB],
        [workspaceA.id, workspaceA],
      ]),
    );
    const afterReorder = tracked.current;
    expect(afterReorder).not.toBe(before);
    expect(afterReorder).toEqual(["workspace-b", "workspace-a"]);

    useSessionStore.getState().mergeWorkspaces(SERVER_ID, [{ ...workspaceA, status: "running" }]);
    expect(tracked.current).toBe(afterReorder);

    tracked.stop();
  });
});

describe("selectRecommendedProjectPaths", () => {
  it("updates when an existing workspace project root changes", () => {
    const workspace = createWorkspace({ id: "workspace-a", projectRootPath: "/repo/a" });
    initializeWorkspaces([workspace]);

    useSessionStore
      .getState()
      .mergeWorkspaces(SERVER_ID, [{ ...workspace, projectRootPath: "/repo/b" }]);

    expect(selectRecommendedProjectPaths(useSessionStore.getState(), SERVER_ID)).toEqual([
      "/repo/b",
    ]);
  });

  it("keeps the path list reference under unrelated workspace updates", () => {
    const workspace = createWorkspace({ id: "workspace-a", projectRootPath: "/repo/a" });
    initializeWorkspaces([workspace]);

    const tracked = trackSelector(
      useSessionStore,
      (state) => selectRecommendedProjectPaths(state, SERVER_ID),
      workspaceEqualityFns.deep,
    );
    const before = tracked.current;

    useSessionStore.getState().mergeWorkspaces(SERVER_ID, [{ ...workspace, status: "running" }]);
    expect(tracked.current).toBe(before);

    tracked.stop();
  });
});

describe("selectHasWorkspaces", () => {
  it("stays stable when workspace membership changes without flipping the boolean", () => {
    const workspaceA = createWorkspace({ id: "workspace-a" });
    const workspaceB = createWorkspace({ id: "workspace-b" });
    initializeWorkspaces([workspaceA]);

    const tracked = trackSelector(
      useSessionStore,
      (state) => selectHasWorkspaces(state, SERVER_ID),
      workspaceEqualityFns.identity,
    );
    const before = tracked.current;

    useSessionStore.getState().mergeWorkspaces(SERVER_ID, [workspaceB]);
    expect(tracked.current).toBe(before);

    tracked.stop();
  });
});

describe("selectResolveWorkspaceIdByCwd", () => {
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

    const tracked = trackSelector(
      useSessionStore,
      (state) => selectResolveWorkspaceIdByCwd(state, SERVER_ID, "/repo/a"),
      workspaceEqualityFns.identity,
    );
    const before = tracked.current;
    expect(before).toBe("workspace-a");

    useSessionStore.getState().mergeWorkspaces(SERVER_ID, [{ ...workspaceB, status: "running" }]);
    expect(tracked.current).toBe(before);

    tracked.stop();
  });
});

describe("selectWorkspaceStatusesForBadges", () => {
  it("tracks status changes without changing for no-ops or unrelated descriptor updates", () => {
    const workspaceA = createWorkspace({ id: "workspace-a", status: "done" });
    const workspaceB = createWorkspace({ id: "workspace-b", status: "attention" });
    initializeWorkspaces([workspaceA, workspaceB]);

    const tracked = trackSelector(
      useSessionStore,
      (state) => selectWorkspaceStatusesForBadges(state),
      workspaceEqualityFns.deep,
    );
    const before = tracked.current;
    expect(before).toEqual(["done", "attention"]);

    useSessionStore
      .getState()
      .mergeWorkspaces(SERVER_ID, [{ ...workspaceA, scripts: [...workspaceA.scripts] }]);
    expect(tracked.current).toBe(before);

    useSessionStore.getState().mergeWorkspaces(SERVER_ID, [{ ...workspaceB, name: "Renamed" }]);
    expect(tracked.current).toBe(before);

    useSessionStore.getState().mergeWorkspaces(SERVER_ID, [{ ...workspaceA, status: "failed" }]);
    expect(tracked.current).not.toBe(before);
    expect(tracked.current).toEqual(["failed", "attention"]);

    tracked.stop();
  });
});
