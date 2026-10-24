import appPackage from "../../package.json";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const { navigateToWorkspace } = vi.hoisted(() => ({ navigateToWorkspace: vi.fn() }));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));
vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));
vi.mock("@/stores/navigation-active-workspace-store", () => ({ navigateToWorkspace }));
vi.mock("./client-runtime", () => ({
  createPluginClientRuntime: () => ({
    paseo: {},
    rpc: async () => undefined,
    openSurface: () => undefined,
    openPanel: () => undefined,
    addComposerPill: () => ({ update() {}, remove() {} }),
    addHeaderButton: () => ({ update() {}, remove() {} }),
  }),
}));

import {
  collectAllTabs,
  findPaneById,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { createPluginNavigation } from "./navigation";
import { pluginRegistry } from "./registry";

const WORKSPACE_KEY = "host-1:workspace-1";
const BUNDLE = `(function() {
  return { default: function(plugin) {
    plugin.addWorkspacePanel({
      id: "tasks",
      title: "Tasks",
      icon: "Scan",
      context: "workspace",
      locations: ["workspace", "explorer"],
      Component: function Tasks() { return null; },
    });
    return function() {};
  }};
})`;

function layout() {
  return useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
}

function pluginTabId(): string | undefined {
  return collectAllTabs(layout().root).find((tab) => tab.target.kind === "plugin")?.tabId;
}

beforeEach(() => {
  navigateToWorkspace.mockClear();
  useWorkspaceLayoutStore.setState({
    layoutByWorkspace: {},
    explorerSidebarPaneIdByWorkspace: {},
    sidePaneIdByWorkspace: {},
    splitSizesByWorkspace: {},
  });
  pluginRegistry.removeHost("host-1");
  pluginRegistry.installCatalog(
    "host-1",
    [{ id: "review", requirements: { paseo: `>=${appPackage.version}` }, clientBundle: BUNDLE }],
    { client: {} as DaemonClient, audio: { play: async () => 0 } },
  );
  useWorkspaceLayoutStore.getState().openTab({
    workspaceKey: WORKSPACE_KEY,
    target: { kind: "agent", agentId: "agent-1" },
    intent: "reveal",
  });
});

describe("plugin panel navigation", () => {
  const navigation = createPluginNavigation({ serverId: "host-1", workspaceId: "workspace-1" });

  it("navigates to the workspace and shows Explorer for a foreground Explorer open", () => {
    navigation.openWorkspacePanel("review", "tasks", "explorer");

    expect(navigateToWorkspace).toHaveBeenCalledTimes(1);
    expect(findPaneById(layout().root, "explorer")!.hidden).not.toBe(true);
  });

  it("selects a background panel in a hidden Explorer without showing it", () => {
    const before = layout();

    navigation.openWorkspacePanel("review", "tasks", "explorer", true);

    const explorer = findPaneById(layout().root, "explorer")!;
    expect(navigateToWorkspace).not.toHaveBeenCalled();
    expect(explorer.hidden).toBe(true);
    expect(explorer.tabIds).toEqual(["files", "changes_tree", pluginTabId()]);
    expect(explorer.focusedTabId).toBe(pluginTabId());
    expect(layout().focusedPaneId).toBe(before.focusedPaneId);
    expect(findPaneById(layout().root, "main")).toEqual(findPaneById(before.root, "main"));
  });

  it("leaves the selected tab alone when Explorer is on screen", () => {
    useWorkspaceLayoutStore.getState().showExplorerSidebar(WORKSPACE_KEY);
    const before = layout();

    navigation.openWorkspacePanel("review", "tasks", "explorer", true);

    const explorer = findPaneById(layout().root, "explorer")!;
    expect(navigateToWorkspace).not.toHaveBeenCalled();
    expect(explorer.tabIds).toContain(pluginTabId());
    expect(explorer.focusedTabId).toBe(findPaneById(before.root, "explorer")!.focusedTabId);
    expect(layout().focusedPaneId).toBe(before.focusedPaneId);
  });

  it("adds a background workspace panel behind the current tab", () => {
    const before = layout();

    navigation.openWorkspacePanel("review", "tasks", "workspace", true);

    const main = findPaneById(layout().root, "main")!;
    expect(navigateToWorkspace).not.toHaveBeenCalled();
    expect(main.tabIds).toContain(pluginTabId());
    expect(main.focusedTabId).toBe(findPaneById(before.root, "main")!.focusedTabId);
    expect(findPaneById(layout().root, "explorer")!.hidden).toBe(true);
  });

  it("keeps the user's selection when the panel is already open", () => {
    navigation.openWorkspacePanel("review", "tasks", "explorer", true);
    const tabId = pluginTabId()!;
    useWorkspaceLayoutStore.getState().selectTabInPane(WORKSPACE_KEY, "explorer", "files");
    useWorkspaceLayoutStore.getState().hideExplorerSidebar(WORKSPACE_KEY);

    navigation.openWorkspacePanel("review", "tasks", "explorer", true);

    const explorer = findPaneById(layout().root, "explorer")!;
    expect(explorer.tabIds).toEqual(["files", "changes_tree", tabId]);
    expect(explorer.focusedTabId).toBe("files");
    expect(explorer.hidden).toBe(true);
  });
});
