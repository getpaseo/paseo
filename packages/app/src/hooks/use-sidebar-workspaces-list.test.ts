/**
 * @vitest-environment jsdom
 */
import { act } from "@testing-library/react";
import type { DaemonClient } from "@server/client/daemon-client";
import { createRoot, type Root } from "react-dom/client";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

import {
  appendMissingOrderKeys,
  applyStoredOrdering,
  buildSidebarProjectsFromStructure,
  useSidebarWorkspacesList,
} from "./use-sidebar-workspaces-list";
import type { WorkspaceStructureProject } from "@/stores/session-store-hooks";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";

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
}): WorkspaceStructureProject {
  return {
    projectKey: input.projectKey,
    projectName: input.projectName ?? input.projectKey,
    projectKind: input.projectKind ?? "git",
    iconWorkingDir: input.iconWorkingDir ?? input.projectKey,
    workspaceKeys: input.workspaceKeys,
  };
}

function workspaceDescriptor(id: string): WorkspaceDescriptor {
  return {
    id,
    projectId: "project-1",
    projectDisplayName: "Project 1",
    projectRootPath: "/repo/main",
    workspaceDirectory: `/repo/main/${id}`,
    projectKind: "git",
    workspaceKind: "worktree",
    name: id,
    status: "done",
    diffStat: null,
    scripts: [],
  };
}

function DisabledHookProbe({ serverId }: { serverId: string }): null {
  const result = useSidebarWorkspacesList({ serverId, enabled: false });

  expect(result.projects).toEqual([]);
  expect(result.isLoading).toBe(false);
  expect(result.isInitialLoad).toBe(false);
  expect(result.isRevalidating).toBe(false);

  return null;
}

function DisabledRenderCountProbe({
  onRender,
  serverId,
}: {
  onRender: () => void;
  serverId: string;
}): null {
  useSidebarWorkspacesList({ serverId, enabled: false });
  onRender();
  return null;
}

function HookResultProbe({
  onResult,
  serverId,
}: {
  onResult: (result: ReturnType<typeof useSidebarWorkspacesList>) => void;
  serverId: string;
}): null {
  onResult(useSidebarWorkspacesList({ serverId }));
  return null;
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
      serverId: "srv",
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
      serverId: "srv",
      projects: [
        project({ projectKey: "project-b", workspaceKeys: ["ws-b"] }),
        project({ projectKey: "project-a", workspaceKeys: ["ws-a"] }),
      ],
    });

    expect(projects.map((project) => project.projectKey)).toEqual(["project-b", "project-a"]);
  });

  it("preserves the structure hook workspace order", () => {
    const projects = buildSidebarProjectsFromStructure({
      serverId: "srv",
      projects: [project({ projectKey: "project-1", workspaceKeys: ["feature", "main"] })],
    });

    expect(projects[0]?.workspaces.map((workspace) => workspace.workspaceId)).toEqual([
      "feature",
      "main",
    ]);
  });
});

describe("useSidebarWorkspacesList", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    container?.remove();
    container = null;
    act(() => {
      getHostRuntimeStore().syncHosts([]);
      useSessionStore.getState().clearSession("srv-disabled");
      useSessionStore.getState().clearSession("srv-loading");
      useSidebarOrderStore.setState({
        projectOrderByServerId: {},
        workspaceOrderByServerAndProject: {},
      });
    });
  });

  it("honors enabled false without appending persisted order keys", async () => {
    act(() => {
      useSessionStore.getState().initializeSession("srv-disabled", null as unknown as DaemonClient);
      useSessionStore
        .getState()
        .setWorkspaces("srv-disabled", new Map([["ws-main", workspaceDescriptor("ws-main")]]));
      useSessionStore.getState().setHasHydratedWorkspaces("srv-disabled", true);
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(React.createElement(DisabledHookProbe, { serverId: "srv-disabled" }));
    });

    expect(useSidebarOrderStore.getState().projectOrderByServerId).toEqual({});
    expect(useSidebarOrderStore.getState().workspaceOrderByServerAndProject).toEqual({});
  });

  it("keeps the sidebar in initial load until workspace hydration succeeds", async () => {
    const onResult = vi.fn();

    act(() => {
      useSessionStore.getState().initializeSession("srv-loading", null as unknown as DaemonClient);
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(React.createElement(HookResultProbe, { serverId: "srv-loading", onResult }));
    });

    expect(onResult).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projects: [],
        isLoading: true,
        isInitialLoad: true,
      }),
    );
  });

  it("does not subscribe to order updates while disabled", async () => {
    const onRender = vi.fn();

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        React.createElement(DisabledRenderCountProbe, {
          serverId: "srv-disabled",
          onRender,
        }),
      );
    });

    expect(onRender).toHaveBeenCalledTimes(1);

    await act(async () => {
      useSidebarOrderStore.getState().setProjectOrder("srv-disabled", ["project-a"]);
    });

    expect(onRender).toHaveBeenCalledTimes(1);
  });
});
