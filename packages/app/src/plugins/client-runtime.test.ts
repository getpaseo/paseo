import { QueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PluginComposerPillProps } from "@getpaseo/plugin/client";
import { afterEach, describe, expect, it } from "vitest";
import type { InstalledPlugin } from "./types";
import { createPluginClientRuntime } from "./client-runtime";
import { pluginComposerPillStore } from "./composer-pills/store";

function Pill(_props: PluginComposerPillProps) {
  return null;
}

function installation(): InstalledPlugin {
  return {
    id: "review",
    serverId: "host-a",
    clientBundle: "bundle",
    queryClient: new QueryClient(),
    cleanup: () => undefined,
    settingsScreens: [],
    surfaces: [],
    sidebarItems: [],
    workspacePanels: [],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
  };
}

const daemonClient = {} as DaemonClient;
const installations: InstalledPlugin[] = [];

afterEach(() => {
  for (const plugin of installations.splice(0)) {
    pluginComposerPillStore.removeInstallation(plugin);
  }
});

describe("plugin client-side lifecycle", () => {
  it("lets the client runtime add and remove a targeted composer pill", () => {
    const plugin = installation();
    installations.push(plugin);
    const client = createPluginClientRuntime(plugin, daemonClient);

    expect(pluginComposerPillStore.getSnapshot()).toEqual([]);
    const remove = client.addComposerPill({
      id: "review-ready",
      title: "Open review",
      workspaceId: "workspace-a",
      agentId: "agent-a",
      Component: Pill,
      onPress() {},
    });

    expect(
      pluginComposerPillStore.getSnapshot().map(({ contribution }) => ({
        id: contribution.id,
        workspaceId: contribution.workspaceId,
        agentId: contribution.agentId,
      })),
    ).toEqual([{ id: "review-ready", workspaceId: "workspace-a", agentId: "agent-a" }]);

    remove();
    expect(pluginComposerPillStore.getSnapshot()).toEqual([]);
  });

  it("rejects duplicate pills only within the same plugin target", () => {
    const plugin = installation();
    installations.push(plugin);
    const contribution = {
      id: "review-ready",
      title: "Open review",
      workspaceId: "workspace-a",
      agentId: "agent-a",
      Component: Pill,
      onPress() {},
    };

    pluginComposerPillStore.add(plugin, contribution);
    expect(() => pluginComposerPillStore.add(plugin, contribution)).toThrow(
      "Duplicate composer pill: review-ready",
    );
    expect(() =>
      pluginComposerPillStore.add(plugin, { ...contribution, agentId: "agent-b" }),
    ).not.toThrow();
  });
});
