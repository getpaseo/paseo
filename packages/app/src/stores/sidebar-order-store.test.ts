import { describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

import { migrateSidebarOrderState, useSidebarOrderStore } from "./sidebar-order-store";

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
      workspaceSectionsByProject: {},
    });
  });

  it("normalizes pinned workspace order", () => {
    const migrated = migrateSidebarOrderState({
      pinnedWorkspaceOrder: [" host-a:one ", "host-a:one", "", "host-b:two"],
    });

    expect(migrated.pinnedWorkspaceOrder).toEqual(["host-a:one", "host-b:two"]);
  });

  it("normalizes project-scoped section layouts without duplicate workspace placement", () => {
    const migrated = migrateSidebarOrderState({
      workspaceSectionsByProject: {
        " project-a ": [
          {
            id: " finance ",
            name: " Finance ",
            workspaceKeys: ["host-a:one", "host-a:one", ""],
          },
          {
            id: "research",
            name: "Research",
            workspaceKeys: ["host-a:one", "host-a:two"],
          },
        ],
      },
    });

    expect(migrated).toMatchObject({
      workspaceSectionsByProject: {
        "project-a": [
          { id: "finance", name: "Finance", workspaceKeys: ["host-a:one"] },
          { id: "research", name: "Research", workspaceKeys: ["host-a:two"] },
        ],
      },
    });
  });

  it("moves a workspace between sections and leaves it unsectioned when its section is deleted", () => {
    useSidebarOrderStore.setState({
      workspaceSectionsByProject: {
        project: [
          { id: "finance", name: "Finance", workspaceKeys: ["srv:one"] },
          { id: "research", name: "Research", workspaceKeys: [] },
        ],
      },
    });
    const store = useSidebarOrderStore.getState();

    store.moveWorkspaceToSection("project", "srv:one", "research");

    expect(useSidebarOrderStore.getState().getWorkspaceSections("project")).toEqual([
      { id: "finance", name: "Finance", workspaceKeys: [] },
      { id: "research", name: "Research", workspaceKeys: ["srv:one"] },
    ]);

    useSidebarOrderStore.getState().deleteWorkspaceSection("project", "research");

    expect(useSidebarOrderStore.getState().getWorkspaceSections("project")).toEqual([
      { id: "finance", name: "Finance", workspaceKeys: [] },
    ]);
    useSidebarOrderStore.setState({ workspaceSectionsByProject: {} });
  });

  it("moves selected workspaces together and preserves their selection order", () => {
    useSidebarOrderStore.setState({
      workspaceSectionsByProject: {
        project: [
          { id: "finance", name: "Finance", workspaceKeys: ["srv:one"] },
          { id: "research", name: "Research", workspaceKeys: ["srv:two"] },
        ],
      },
    });

    useSidebarOrderStore
      .getState()
      .moveWorkspacesToSection("project", ["srv:two", "srv:one"], "finance");

    expect(useSidebarOrderStore.getState().getWorkspaceSections("project")).toEqual([
      { id: "finance", name: "Finance", workspaceKeys: ["srv:two", "srv:one"] },
      { id: "research", name: "Research", workspaceKeys: [] },
    ]);
    useSidebarOrderStore.setState({ workspaceSectionsByProject: {} });
  });

  it("creates, renames, and reorders sections while retaining empty sections", () => {
    useSidebarOrderStore.setState({ workspaceSectionsByProject: {} });
    const store = useSidebarOrderStore.getState();

    store.createWorkspaceSection("project", " Finance ");
    store.createWorkspaceSection("project", "Research");
    const [finance, research] = useSidebarOrderStore.getState().getWorkspaceSections("project");
    expect(finance?.name).toBe("Finance");
    expect(research?.name).toBe("Research");
    expect(finance?.workspaceKeys).toEqual([]);

    useSidebarOrderStore.getState().renameWorkspaceSection("project", finance?.id ?? "", "Waiting");
    useSidebarOrderStore
      .getState()
      .reorderWorkspaceSections("project", [research?.id ?? "", finance?.id ?? ""]);

    expect(useSidebarOrderStore.getState().getWorkspaceSections("project")).toMatchObject([
      { name: "Research", workspaceKeys: [] },
      { name: "Waiting", workspaceKeys: [] },
    ]);
    useSidebarOrderStore.setState({ workspaceSectionsByProject: {} });
  });
});
