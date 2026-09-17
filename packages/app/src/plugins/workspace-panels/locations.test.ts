import appPackage from "../../../package.json";
import { describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { pluginRegistry } from "../registry";
import { panelTargetSupportsHost, resolvePluginPanelOpenLocation } from "./locations";

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

function install(locations: readonly ("workspace" | "explorer")[]) {
  const bundle = `(function() {
    return { default: function(plugin) {
      plugin.addWorkspacePanel({
        id: "details",
        title: "Details",
        icon: "Scan",
        context: "agent",
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
