import { QueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PluginClientContext, PluginComposerPillProps } from "@getpaseo/plugin";
import { afterEach, describe, expect, it } from "vitest";
import type { InstalledPlugin } from "../types";
import { startPluginClientSide } from "./lifecycle";
import { pluginComposerPillStore } from "./store";

function Pill(_props: PluginComposerPillProps) {
  return null;
}

function installation(clientSide: NonNullable<InstalledPlugin["clientSide"]>): InstalledPlugin {
  return {
    id: "review",
    serverId: "host-a",
    clientBundle: "bundle",
    queryClient: new QueryClient(),
    cleanup: () => undefined,
    surfaces: [],
    sidebarItems: [],
    workspacePanels: [],
    commandCenterItems: [],
    clientSide,
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
  it("lets client code add and remove a targeted composer pill at runtime", async () => {
    const captured: { client?: PluginClientContext } = {};
    let cleanupCount = 0;
    const plugin = installation((context) => {
      captured.client = context;
      return () => {
        cleanupCount += 1;
      };
    });
    installations.push(plugin);
    const stop = startPluginClientSide(plugin, daemonClient);
    const client = captured.client;
    if (!client) throw new Error("Client lifecycle did not start");

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

    client.addComposerPill({
      id: "review-ready",
      title: "Open review",
      workspaceId: "workspace-a",
      agentId: "agent-a",
      Component: Pill,
      onPress() {},
    });
    await stop();

    expect(pluginComposerPillStore.getSnapshot()).toEqual([]);
    expect(cleanupCount).toBe(1);
  });

  it("rejects duplicate pills only within the same plugin target", () => {
    const plugin = installation(() => () => undefined);
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
