/**
 * @vitest-environment jsdom
 */
import { act } from "@testing-library/react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React from "react";

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

vi.mock("expo-router", () => ({
  router: {
    dismissTo: vi.fn(),
  },
  useLocalSearchParams: () => ({}),
  usePathname: () => "/",
}));

const asyncStorageState = vi.hoisted(() => ({
  resolveGetItem: null as ((value: string | null) => void) | null,
  deferNextGetItem: false,
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(() => {
      if (asyncStorageState.deferNextGetItem) {
        asyncStorageState.deferNextGetItem = false;
        return new Promise<string | null>((resolve) => {
          asyncStorageState.resolveGetItem = resolve;
        });
      }
      return Promise.resolve(null);
    }),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

import {
  useSidebarWorkspacesList,
  type SidebarProjectEntry,
  type SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { HostProfile } from "@/types/host-connection";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { hasVisibleOrderChanged, mergeWithRemainder } from "@/utils/sidebar-reorder";

const SERVER_A = "host-filter-server-a";
const SERVER_B = "host-filter-server-b";

function workspace(input: {
  id: string;
  projectId: string;
  projectDisplayName: string;
  name: string;
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
    status: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };
}

function hostAWorkspaces(): WorkspaceDescriptor[] {
  return [
    workspace({
      id: "a-main",
      projectId: "project-a",
      projectDisplayName: "Project A",
      name: "main",
    }),
    workspace({
      id: "a-one",
      projectId: "project-a",
      projectDisplayName: "Project A",
      name: "one",
    }),
    workspace({
      id: "a-two",
      projectId: "project-a",
      projectDisplayName: "Project A",
      name: "two",
    }),
  ];
}

function hostBWorkspaces(): WorkspaceDescriptor[] {
  return [
    workspace({
      id: "b-main",
      projectId: "project-b",
      projectDisplayName: "Project B",
      name: "main",
    }),
    workspace({
      id: "b-one",
      projectId: "project-b",
      projectDisplayName: "Project B",
      name: "one",
    }),
  ];
}

function makeHost(serverId: string, label: string): HostProfile {
  const now = "2026-04-19T00:00:00.000Z";
  return {
    serverId,
    label,
    lifecycle: {},
    connections: [],
    preferredConnectionId: null,
    createdAt: now,
    updatedAt: now,
  };
}

function setHostProfiles(hosts: HostProfile[]): void {
  (
    getHostRuntimeStore() as unknown as {
      setHostsAndSync: (hosts: HostProfile[]) => void;
    }
  ).setHostsAndSync(hosts);
}

function initializeHost(serverId: string, workspaces: WorkspaceDescriptor[]): void {
  useSessionStore.getState().initializeSession(serverId, null as unknown as DaemonClient);
  useSessionStore
    .getState()
    .setWorkspaces(serverId, new Map(workspaces.map((entry) => [entry.id, entry])));
  useSessionStore.getState().setHasHydratedWorkspaces(serverId, true);
}

interface ProbeResult {
  projects: SidebarProjectEntry[];
}

function Probe({ result }: { result: ProbeResult }): null {
  const { projects } = useSidebarWorkspacesList();
  result.projects = projects;
  return null;
}

// Mirrors handleWorkspaceReorder in sidebar-workspace-list.tsx: the sidebar hands the
// reordered visible placements to the order store through mergeWithRemainder.
function simulateWorkspaceDrag(
  projectKey: string,
  reorderedWorkspaces: SidebarWorkspacePlacement[],
): void {
  const reorderedWorkspaceKeys = reorderedWorkspaces.map((entry) => entry.workspaceKey);
  const orderStore = useSidebarOrderStore.getState();
  const currentWorkspaceOrder = orderStore.getWorkspaceOrder(projectKey);
  if (
    !hasVisibleOrderChanged({
      currentOrder: currentWorkspaceOrder,
      reorderedVisibleKeys: reorderedWorkspaceKeys,
    })
  ) {
    return;
  }
  orderStore.setWorkspaceOrder(
    projectKey,
    mergeWithRemainder({
      currentOrder: currentWorkspaceOrder,
      reorderedVisibleKeys: reorderedWorkspaceKeys,
    }),
  );
}

function workspaceIdsOf(result: ProbeResult, projectKey: string): string[] {
  const project = result.projects.find((entry) => entry.projectKey === projectKey);
  return project ? project.workspaces.map((entry) => entry.workspaceId) : [];
}

async function setHostFilters(filters: string[]): Promise<void> {
  await act(async () => {
    useSidebarViewStore.setState({ hostFilters: filters });
  });
}

describe("useSidebarWorkspacesList host filter ordering", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    act(() => {
      setHostProfiles([makeHost(SERVER_A, "Host A"), makeHost(SERVER_B, "Host B")]);
      initializeHost(SERVER_A, hostAWorkspaces());
      initializeHost(SERVER_B, hostBWorkspaces());
      useSidebarOrderStore.setState({
        projectOrder: [],
        workspaceOrderByProject: {},
      });
      useSidebarViewStore.setState({ hostFilters: [SERVER_A] });
    });
  });

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
      setHostProfiles([]);
      useSessionStore.getState().clearSession(SERVER_A);
      useSessionStore.getState().clearSession(SERVER_B);
      useSidebarOrderStore.setState({
        projectOrder: [],
        workspaceOrderByProject: {},
      });
      useSidebarViewStore.setState({ hostFilters: [] });
    });
  });

  async function renderProbe(result: ProbeResult): Promise<void> {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<Probe result={result} />);
    });
  }

  it("keeps a manual workspace order after switching the host filter away and back", async () => {
    const result: ProbeResult = { projects: [] };
    await renderProbe(result);

    expect(workspaceIdsOf(result, "project-a")).toEqual(["a-main", "a-one", "a-two"]);

    // Drag "a-two" to the top while filtered to host A.
    const projectA = result.projects.find((entry) => entry.projectKey === "project-a");
    expect(projectA).toBeDefined();
    const reordered = [
      projectA!.workspaces[2]!,
      projectA!.workspaces[0]!,
      projectA!.workspaces[1]!,
    ];
    await act(async () => {
      simulateWorkspaceDrag("project-a", reordered);
    });
    expect(workspaceIdsOf(result, "project-a")).toEqual(["a-two", "a-main", "a-one"]);

    // Switch the sidebar filter to host B, then back to host A.
    await setHostFilters([SERVER_B]);
    expect(workspaceIdsOf(result, "project-b")).toEqual(["b-main", "b-one"]);

    await setHostFilters([SERVER_A]);

    expect(workspaceIdsOf(result, "project-a")).toEqual(["a-two", "a-main", "a-one"]);
    expect(useSidebarOrderStore.getState().workspaceOrderByProject["project-a"]).toEqual([
      `${SERVER_A}:a-two`,
      `${SERVER_A}:a-main`,
      `${SERVER_A}:a-one`,
    ]);
  });

  it("keeps the persisted custom order when writes land before persist hydration resolves", async () => {
    // Simulates the persist race: the reconcile effect (or a drag) writes against the
    // pre-hydration empty store, then AsyncStorage hydration resolves with the user's
    // stored custom order. zustand's persist merge must let the persisted order win.
    asyncStorageState.deferNextGetItem = true;
    vi.resetModules();
    const { useSidebarOrderStore: freshStore } = await import("@/stores/sidebar-order-store");

    // Pre-hydration write: reconcile-style default seeding.
    freshStore
      .getState()
      .setWorkspaceOrder("project-a", [
        `${SERVER_A}:a-main`,
        `${SERVER_A}:a-one`,
        `${SERVER_A}:a-two`,
      ]);

    // Hydration resolves afterwards with the user's custom order.
    asyncStorageState.resolveGetItem?.(
      JSON.stringify({
        state: {
          projectOrder: ["project-a"],
          workspaceOrderByProject: {
            "project-a": [`${SERVER_A}:a-two`, `${SERVER_A}:a-main`, `${SERVER_A}:a-one`],
          },
        },
        version: 1,
      }),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(freshStore.getState().workspaceOrderByProject["project-a"]).toEqual([
      `${SERVER_A}:a-two`,
      `${SERVER_A}:a-main`,
      `${SERVER_A}:a-one`,
    ]);
  });

  it("keeps a manual workspace order when the filter passes through the all-hosts state", async () => {
    const result: ProbeResult = { projects: [] };
    await renderProbe(result);

    const projectA = result.projects.find((entry) => entry.projectKey === "project-a");
    expect(projectA).toBeDefined();
    const reordered = [
      projectA!.workspaces[2]!,
      projectA!.workspaces[0]!,
      projectA!.workspaces[1]!,
    ];
    await act(async () => {
      simulateWorkspaceDrag("project-a", reordered);
    });
    expect(workspaceIdsOf(result, "project-a")).toEqual(["a-two", "a-main", "a-one"]);

    // Toggling filters in the UI walks through intermediate states:
    // [A] -> [] (all hosts) -> [B] -> [] -> [A]
    await setHostFilters([]);
    await setHostFilters([SERVER_B]);
    await setHostFilters([]);
    await setHostFilters([SERVER_A]);

    expect(workspaceIdsOf(result, "project-a")).toEqual(["a-two", "a-main", "a-one"]);
  });
});
