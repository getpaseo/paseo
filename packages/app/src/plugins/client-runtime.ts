import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PluginClientOpenPanelOptions } from "@getpaseo/plugin";
import {
  createPluginAgentActionContext,
  createPluginCapabilities,
  createPluginWorkspaceActionContext,
} from "./actions";
import { createPluginClientStateSource } from "./client-state/source";
import type { PluginClientRuntime } from "./evaluate";
import { createPluginNavigation } from "./navigation";
import { pluginComposerPillStore } from "./composer-pills/store";
import { createPluginSurfaceRuntime } from "./surface-runtime";
import type { InstalledPlugin } from "./types";

export function createPluginClientRuntime(
  installation: InstalledPlugin,
  daemonClient: DaemonClient,
): PluginClientRuntime {
  const runtime = createPluginSurfaceRuntime(daemonClient, installation.id);
  if (!runtime) throw new Error("Plugin host is offline");
  const state = createPluginClientStateSource(installation.serverId);
  const capabilities = createPluginCapabilities(
    installation,
    runtime,
    createPluginNavigation({ serverId: installation.serverId, workspaceId: null }),
  );
  return {
    ...capabilities,
    addComposerPill(contribution) {
      return pluginComposerPillStore.add(installation, contribution);
    },
    openPanel(panelId, options) {
      openClientPanel({ installation, runtime, state, panelId, options });
    },
  };
}

function openClientPanel(input: {
  installation: InstalledPlugin;
  runtime: NonNullable<ReturnType<typeof createPluginSurfaceRuntime>>;
  state: ReturnType<typeof createPluginClientStateSource>;
  panelId: string;
  options: PluginClientOpenPanelOptions;
}): void {
  const { installation, runtime, state, panelId, options } = input;
  const workspaceId = options.workspaceId.trim();
  const agentId = options.agentId?.trim();
  const navigation = createPluginNavigation({ serverId: installation.serverId, workspaceId });
  const action = agentId
    ? createPluginAgentActionContext({
        plugin: installation,
        runtime,
        navigation,
        state,
        workspaceId,
        agentId,
      })
    : createPluginWorkspaceActionContext({
        plugin: installation,
        runtime,
        navigation,
        state,
        workspaceId,
      });
  if (!action) throw new Error("Plugin panel context is unavailable");
  action.openPanel(panelId, { location: options.location });
}
