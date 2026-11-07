import appPackage from "../../package.json";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { seedSessionHosts, seedSessionWorkspaces } from "@/test/seed-session";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import {
  collectAllTabs,
  findPaneById,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { pluginRegistry } from "./registry";

const SERVER_ID = "host-1";
const WORKSPACE_ID = "workspace-1";
const WORKSPACE_KEY = `${SERVER_ID}:${WORKSPACE_ID}`;
// The bundle hands its client to the test, so every open goes through the plugin-facing API.
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
    globalThis.__navigationTestPlugin = plugin;
    return function() { delete globalThis.__navigationTestPlugin; };
  }};
})`;

const workspace: WorkspaceDescriptor = {
  createdAt: null,
  lastUserMessageAt: null,
  id: WORKSPACE_ID,
  projectId: "project-1",
  projectDisplayName: "Project",
  projectRootPath: "/repo/project",
  workspaceDirectory: "/repo/project",
  projectKind: "git",
  workspaceKind: "checkout",
  name: "main",
  status: "done",
  archivingAt: null,
  statusEnteredAt: null,
  diffStat: null,
  scripts: [],
};

function plugin(): PluginClientContext {
  const client = (globalThis as { __navigationTestPlugin?: PluginClientContext })
    .__navigationTestPlugin;
  if (!client) throw new Error("The test plugin did not load");
  return client;
}

function openTasks(options: { location: "workspace" | "explorer"; background?: boolean }) {
  plugin().openPanel("tasks", { workspaceId: WORKSPACE_ID, ...options });
}

function layout() {
  return useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
}

function explorer() {
  return findPaneById(layout().root, "explorer")!;
}

function pluginTabId(): string | undefined {
  return collectAllTabs(layout().root).find((tab) => tab.target.kind === "plugin")?.tabId;
}

beforeEach(() => {
  seedSessionHosts([SERVER_ID]);
  useSessionStore.getState().initializeSession(SERVER_ID, {} as DaemonClient);
  seedSessionWorkspaces(SERVER_ID, new Map([[WORKSPACE_ID, workspace]]));
  useWorkspaceLayoutStore.setState({
    layoutByWorkspace: {},
    explorerSidebarPaneIdByWorkspace: {},
    sidePaneIdByWorkspace: {},
    splitSizesByWorkspace: {},
  });
  pluginRegistry.installCatalog(
    SERVER_ID,
    [{ id: "review", requirements: { paseo: `>=${appPackage.version}` }, clientBundle: BUNDLE }],
    { client: {} as DaemonClient, audio: { play: async () => 0 } },
  );
  useWorkspaceLayoutStore.getState().openTab({
    workspaceKey: WORKSPACE_KEY,
    target: { kind: "agent", agentId: "agent-1" },
    intent: "reveal",
  });
});

afterEach(() => {
  pluginRegistry.removeHost(SERVER_ID);
  useSessionStore.setState((state) => ({ ...state, sessions: {} }));
  seedSessionHosts([]);
});

describe("plugin panel opens", () => {
  it("shows Explorer and the panel for a foreground Explorer open", () => {
    openTasks({ location: "explorer" });

    expect(explorer().hidden).not.toBe(true);
    expect(explorer().focusedTabId).toBe(pluginTabId());
  });

  it("selects a background panel in a hidden Explorer without showing it", () => {
    const before = layout();

    openTasks({ location: "explorer", background: true });

    expect(explorer().hidden).toBe(true);
    expect(explorer().tabIds).toEqual(["files", "changes_tree", pluginTabId()]);
    expect(explorer().focusedTabId).toBe(pluginTabId());
    expect(layout().focusedPaneId).toBe(before.focusedPaneId);
    expect(findPaneById(layout().root, "main")).toEqual(findPaneById(before.root, "main"));
  });

  it("leaves the selected tab alone when Explorer is on screen", () => {
    useWorkspaceLayoutStore.getState().showExplorerSidebar(WORKSPACE_KEY);
    const before = layout();

    openTasks({ location: "explorer", background: true });

    expect(explorer().tabIds).toContain(pluginTabId());
    expect(explorer().focusedTabId).toBe(findPaneById(before.root, "explorer")!.focusedTabId);
    expect(layout().focusedPaneId).toBe(before.focusedPaneId);
  });

  it("adds a background workspace panel behind the current tab", () => {
    const before = layout();

    openTasks({ location: "workspace", background: true });

    const main = findPaneById(layout().root, "main")!;
    expect(main.tabIds).toContain(pluginTabId());
    expect(main.focusedTabId).toBe(findPaneById(before.root, "main")!.focusedTabId);
    expect(explorer().hidden).toBe(true);
  });

  it("keeps the user's selection when the panel is already open", () => {
    openTasks({ location: "explorer", background: true });
    const tabId = pluginTabId()!;
    useWorkspaceLayoutStore.getState().selectTabInPane(WORKSPACE_KEY, "explorer", "files");
    useWorkspaceLayoutStore.getState().hideExplorerSidebar(WORKSPACE_KEY);

    openTasks({ location: "explorer", background: true });

    expect(explorer().tabIds).toEqual(["files", "changes_tree", tabId]);
    expect(explorer().focusedTabId).toBe("files");
    expect(explorer().hidden).toBe(true);
  });
});
