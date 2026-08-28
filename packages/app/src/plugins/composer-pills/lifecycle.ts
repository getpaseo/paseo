import type {
  PluginCleanup,
  PluginClientContext,
  PluginClientOpenPanelOptions,
} from "@getpaseo/plugin";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  createPluginAgentActionContext,
  createPluginCapabilities,
  createPluginWorkspaceActionContext,
} from "../actions";
import { createPluginClientStateSource } from "../client-state/source";
import { createPluginNavigation } from "../navigation";
import { createPluginSurfaceRuntime } from "../surface-runtime";
import type { InstalledPlugin } from "../types";
import { pluginComposerPillStore } from "./store";

export function startPluginClientSide(
  installation: InstalledPlugin,
  daemonClient: DaemonClient,
): PluginCleanup {
  if (!installation.clientSide) return () => undefined;
  const runtime = createPluginSurfaceRuntime(daemonClient, installation.id);
  if (!runtime) throw new Error("Plugin host is offline");
  const state = createPluginClientStateSource(installation.serverId);
  const capabilities = createPluginCapabilities(
    installation,
    runtime,
    createPluginNavigation({ serverId: installation.serverId, workspaceId: null }),
  );
  const context: PluginClientContext = {
    ...capabilities,
    addComposerPill(contribution) {
      return pluginComposerPillStore.add(installation, contribution);
    },
    openPanel(panelId, options) {
      openClientPanel({ installation, runtime, state, panelId, options });
    },
  };

  let cleanup: PluginCleanup;
  try {
    cleanup = installation.clientSide(context);
    if (typeof cleanup !== "function") {
      throw new Error("Plugin client-side entrypoint must return a cleanup function");
    }
  } catch (error) {
    pluginComposerPillStore.removeInstallation(installation);
    throw error;
  }

  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
    pluginComposerPillStore.removeInstallation(installation);
    await cleanup();
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
