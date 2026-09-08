import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "../types";
import { resolvePluginWorkspacePanel } from "./resolution";

function installed(): InstalledPlugin {
  return {
    id: "review",
    serverId: "host-1",
    clientBundle: "bundle",
    queryClient: new QueryClient(),
    cleanup: () => {},
    settingsScreens: [],
    surfaces: [],
    sidebarItems: [],
    workspacePanels: [
      {
        id: "details",
        title: "Details",
        icon: "Scan",
        context: "workspace",
        locations: ["workspace"],
        Component: () => null,
      },
    ],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
  };
}

describe("plugin workspace panel resolution", () => {
  it("resolves only the exact plugin, panel, and context", () => {
    const plugin = installed();
    expect(
      resolvePluginWorkspacePanel(plugin, {
        kind: "plugin",
        pluginId: "review",
        panelId: "details",
        context: "workspace",
      })?.title,
    ).toBe("Details");
    expect(
      resolvePluginWorkspacePanel(plugin, {
        kind: "plugin",
        pluginId: "review",
        panelId: "details",
        context: "agent",
        agentId: "agent-1",
      }),
    ).toBeNull();
  });

  it("returns unavailable after the installation disappears", () => {
    expect(
      resolvePluginWorkspacePanel(null, {
        kind: "plugin",
        pluginId: "review",
        panelId: "details",
        context: "workspace",
      }),
    ).toBeNull();
  });
});
