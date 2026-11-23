import { createWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { observePinnedExplorer } from "@/workspace-tabs/pinned-explorer";
import appPackage from "../../../package.json";
import { describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { pluginRegistry } from "../registry";
import { panelTargetSupportsHost, resolvePluginPanelOpenLocation } from "./locations";

const audio = { play: async () => 0 };

vi.mock("../navigation", () => ({
  createPluginNavigation: () => ({}),
}));
vi.mock("../client-runtime", () => ({
  createPluginClientRuntime: () => ({
    paseo: {},
    rpc: async () => undefined,
    openSurface: () => undefined,
    openPanel: () => undefined,
    addComposerPill: () => ({ update() {}, remove() {} }),
    addHeaderButton: () => ({ update() {}, remove() {} }),
  }),
}));

function install(
  locations: readonly ("workspace" | "explorer")[],
  context: "agent" | "workspace" = "agent",
) {
  const bundle = `(function() {
    return { default: function(plugin) {
      plugin.addWorkspacePanel({
        id: "details",
        title: "Details",
        icon: "Scan",
        context: ${JSON.stringify(context)},
        locations: ${JSON.stringify(locations)},
        Component: function Details() { return null; },
      });
      return function() {};
    }};
  })`;
  pluginRegistry.installCatalog(
    "host-1",
    [{ id: "review", requirements: { paseo: `>=${appPackage.version}` }, clientBundle: bundle }],
    {
      client: {} as DaemonClient,
      audio,
    },
  );
  return pluginRegistry.getSnapshot()[0]!;
}

describe("plugin workspace panel locations", () => {
  it("applies the same host contract to agent panel instances", () => {
    install(["workspace", "explorer"]);
    const target = {
      kind: "plugin" as const,
      pluginId: "review",
      panelId: "details",
      context: "agent" as const,
      agentId: "agent-1",
    };
    expect(panelTargetSupportsHost("host-1", target, "main")).toBe(true);
    expect(panelTargetSupportsHost("host-1", target, "explorer")).toBe(true);
    pluginRegistry.removeHost("host-1");
  });

  it("defaults opens to workspace and validates explicit Explorer opens", () => {
    const panel = install(["workspace", "explorer"]).workspacePanels[0]!;
    expect(resolvePluginPanelOpenLocation(panel)).toBe("workspace");
    expect(resolvePluginPanelOpenLocation(panel, "explorer")).toBe("explorer");
    pluginRegistry.removeHost("host-1");

    const workspaceOnly = install(["workspace"]).workspacePanels[0]!;
    expect(() => resolvePluginPanelOpenLocation(workspaceOnly, "explorer")).toThrow(
      "does not support explorer location",
    );
    pluginRegistry.removeHost("host-1");
  });
});

it("preserves a workspace pin while its plugin is disabled and restores its contribution", async () => {
  const store = createWorkspaceLayoutStore(undefined, {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  });
  await store.persist.rehydrate();
  install(["explorer"], "workspace");
  const source = "host-1:first";
  const paneId = store.getState().showExplorerSidebar(source)!;
  const target = {
    kind: "plugin",
    context: "workspace",
    pluginId: "review",
    panelId: "details",
  } as const;
  const tabId = store.getState().openTab({
    workspaceKey: source,
    target,
    intent: "reveal",
    placement: { mode: "pane", paneId },
  })!;
  store.getState().pinExplorerTab("host-1", source, tabId);
  pluginRegistry.removeHost("host-1");
  observePinnedExplorer({ serverId: "host-1", workspaceKey: "host-1:second", store })();
  expect(
    store
      .getState()
      .getWorkspaceTabs("host-1:second")
      .find((tab) => tab.tabId === tabId)?.target,
  ).toEqual(target);
  const installed = install(["explorer"], "workspace");
  expect(installed.workspacePanels.map((panel) => panel.id)).toEqual(["details"]);
  expect(store.getState().pinnedExplorerByHost["host-1"].selectedTabId).toBe(tabId);
  pluginRegistry.removeHost("host-1");
});
