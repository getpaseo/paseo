import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeSidebarOrderUpdates,
  type SidebarProjectEntry,
} from "@/hooks/sidebar-workspaces-view-model";
import { migrateSidebarOrderState, useSidebarOrderStore } from "./sidebar-order-store";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

describe("migrateSidebarOrderState", () => {
  it("prefixes legacy per-server workspace order with the source server id", () => {
    const migrated = migrateSidebarOrderState({
      projectOrderByServerId: {
        "host-a": ["project-a"],
        "host-b": ["project-a"],
      },
      workspaceOrderByServerAndProject: {
        "host-a::project-a": ["main", "feature"],
        "host-b::project-a": ["main"],
      },
    });

    expect(migrated).toEqual({
      projectOrder: ["project-a"],
      pinnedWorkspaceOrder: [],
      workspaceOrderByProject: {
        "project-a": ["host-a:main", "host-a:feature", "host-b:main"],
      },
    });
  });

  it("normalizes pinned workspace order", () => {
    const migrated = migrateSidebarOrderState({
      pinnedWorkspaceOrder: [" host-a:one ", "host-a:one", "", "host-b:two"],
    });

    expect(migrated.pinnedWorkspaceOrder).toEqual(["host-a:one", "host-b:two"]);
  });
});

// A directory whose name ends in a space produces a view key that ends in a
// space. Trimming it on write used to make the sidebar's reconcile effect loop
// forever, crashing the app with React error #185 (see #4880).
describe("sidebar order keys that end in whitespace", () => {
  const PROJECT_KEY = "host:srv-1:/home/u/Reklamation ";

  beforeEach(() => {
    useSidebarOrderStore.setState({
      projectOrder: [],
      pinnedWorkspaceOrder: [],
      workspaceOrderByProject: {},
    });
  });

  it("stores a project key exactly as given", () => {
    useSidebarOrderStore.getState().setProjectOrder([PROJECT_KEY]);

    expect(useSidebarOrderStore.getState().projectOrder).toEqual([PROJECT_KEY]);
  });

  it("scopes a workspace order under the project key the sidebar indexes by", () => {
    useSidebarOrderStore.getState().setWorkspaceOrder(PROJECT_KEY, ["srv-1:main"]);

    // use-sidebar-workspaces-list reads workspaceOrderByProject by view key
    // directly, so the scope has to be stored under that same key.
    expect(useSidebarOrderStore.getState().workspaceOrderByProject[PROJECT_KEY]).toEqual([
      "srv-1:main",
    ]);
    expect(useSidebarOrderStore.getState().getWorkspaceOrder(PROJECT_KEY)).toEqual(["srv-1:main"]);
  });

  it("settles the sidebar order reconcile instead of rewriting it forever", () => {
    const projects: SidebarProjectEntry[] = [
      {
        viewKey: PROJECT_KEY,
        projectName: "Reklamation ",
        projectKind: "non_git",
        iconWorkingDir: "/home/u/Reklamation ",
        hosts: [],
        workspaces: [],
      },
    ];
    const runPass = () =>
      computeSidebarOrderUpdates({
        projects,
        persistedProjectOrder: useSidebarOrderStore.getState().projectOrder,
        getWorkspaceOrder: (key) => useSidebarOrderStore.getState().getWorkspaceOrder(key),
      });

    // First pass adds the newly visible project.
    const first = runPass();
    expect(first.projectOrder).toEqual([PROJECT_KEY]);
    useSidebarOrderStore.getState().setProjectOrder(first.projectOrder ?? []);

    // Second pass must find nothing left to do; otherwise the effect that
    // applies these updates re-runs on every render.
    expect(runPass().projectOrder).toBeNull();
  });

  it("still trims keys when migrating persisted state", () => {
    const migrated = migrateSidebarOrderState({
      projectOrder: [" host-a:one ", "host-a:one"],
    });

    expect(migrated.projectOrder).toEqual(["host-a:one"]);
  });
});
