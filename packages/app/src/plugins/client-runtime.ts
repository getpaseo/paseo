import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  PluginClientOpenPanelOptions,
  PluginClientOpenPanelWithAgentOptions,
} from "@getpaseo/plugin/client";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import {
  createPluginAgentActionContext,
  createPluginCapabilities,
  createPluginWorkspaceActionContext,
} from "./actions";
import { createPluginClientStateSource } from "./client-state/source";
import type { PluginClientRuntime } from "./evaluate";
import { createPluginNavigation } from "./navigation";
import { pluginButtonStore } from "./buttons";
import { createPluginSurfaceRuntime } from "./surface-runtime";
import type { InstalledPlugin } from "./types";
import {
  arrangePanelWithAgent,
  canOpenPanelBesideAgent,
  resolvePanelWithAgent,
} from "./workspace-panels/open-with-agent";

export function createPluginClientRuntime(
  installation: InstalledPlugin,
  daemonClient: DaemonClient,
): PluginClientRuntime {
  const runtime = createPluginSurfaceRuntime(daemonClient, installation);
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
      return pluginButtonStore.addComposerPill(installation, contribution);
    },
    addHeaderButton(contribution) {
      return pluginButtonStore.addHeaderButton(installation, contribution);
    },
    openPanel(panelId, options) {
      openClientPanel({ installation, runtime, state, panelId, options });
    },
    openPanelWithAgent(panelId, options) {
      openClientPanelWithAgent({ installation, state, panelId, options });
    },
  };
}

function openClientPanelWithAgent(input: {
  installation: InstalledPlugin;
  state: ReturnType<typeof createPluginClientStateSource>;
  panelId: string;
  options: PluginClientOpenPanelWithAgentOptions;
}): void {
  const { installation, state } = input;
  const { workspaceId, panel, agent } = resolvePanelWithAgent({
    plugin: installation,
    state,
    panelId: input.panelId,
    workspaceId: input.options.workspaceId,
    agentId: input.options.agentId,
  });
  const serverId = installation.serverId;
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  if (
    !workspaceKey ||
    !canOpenPanelBesideAgent() ||
    !useWorkspaceLayoutStore.persist.hasHydrated()
  ) {
    navigateToAgent({ serverId, agentId: agent.agentId, workspaceId });
    return;
  }
  const agentPaneId = arrangePanelWithAgent({ workspaceKey, panel, agent });
  navigateToWorkspace({
    serverId,
    workspaceId,
    target: agent,
    placement: agentPaneId ? { mode: "pane", paneId: agentPaneId } : undefined,
  });
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
