import { router, usePathname } from "expo-router";
import { useMemo } from "react";
import { useCommandCenterActions } from "@/command-center/provider";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import {
  useActiveWorkspaceSelection,
  navigateToWorkspace,
} from "@/stores/navigation-active-workspace-store";
import { useAgentExistsInWorkspace, useWorkspaceExists } from "@/stores/session-store-hooks";
import { getFocusedAgentId, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { createPluginClientStateSource } from "../client-state/source";
import { buildPluginSurfaceRoute, hostIdFromPathname } from "../routes";
import { useInstalledPlugins } from "../registry";
import { createPluginSurfaceRuntime } from "../surface-runtime";
import { buildPluginCommandCenterContributions } from "./contributions";

export function PluginCommandCenterActions() {
  const pathname = usePathname();
  const selection = useActiveWorkspaceSelection();
  const serverId = selection?.serverId ?? hostIdFromPathname(pathname);
  const workspaceId = selection?.workspaceId ?? null;
  const workspaceExists = useWorkspaceExists(serverId, workspaceId);
  const workspaceKey =
    serverId && workspaceId ? buildWorkspaceTabPersistenceKey({ serverId, workspaceId }) : null;
  const focusedAgentId = useWorkspaceLayoutStore((state) =>
    workspaceKey ? getFocusedAgentId(state.layoutByWorkspace[workspaceKey] ?? null) : null,
  );
  const agentExists = useAgentExistsInWorkspace(serverId, workspaceId, focusedAgentId);
  const client = useHostRuntimeClient(serverId ?? "");
  const installed = useInstalledPlugins();
  const plugins = useMemo(
    () => installed.filter((plugin) => plugin.serverId === serverId),
    [installed, serverId],
  );
  const stateSource = useMemo(
    () => (serverId ? createPluginClientStateSource(serverId) : null),
    [serverId],
  );
  const toast = useToast();
  const actions = useMemo(() => {
    if (!client || !serverId || !stateSource) return [];
    return buildPluginCommandCenterContributions({
      plugins,
      runtime(pluginId) {
        const runtime = createPluginSurfaceRuntime(client, pluginId);
        if (!runtime) throw new Error("Plugin host is offline");
        return runtime;
      },
      state: stateSource,
      workspaceId: workspaceExists ? workspaceId : null,
      agentId: agentExists ? focusedAgentId : null,
      navigation: {
        openSurface(pluginId, surfaceId) {
          router.push(
            buildPluginSurfaceRoute(serverId, pluginId, { kind: "surface", id: surfaceId }),
          );
        },
        openWorkspacePanel(pluginId, panelId) {
          if (!workspaceId) throw new Error("No active workspace");
          navigateToWorkspace({
            serverId,
            workspaceId,
            target: { kind: "plugin", pluginId, panelId, context: "workspace" },
          });
        },
        openAgentPanel(pluginId, panelId, agentId) {
          if (!workspaceId) throw new Error("No active workspace");
          navigateToWorkspace({
            serverId,
            workspaceId,
            target: { kind: "plugin", pluginId, panelId, context: "agent", agentId },
          });
        },
      },
      reportError(error) {
        toast.error(error instanceof Error ? error.message : String(error));
      },
    });
  }, [
    agentExists,
    client,
    focusedAgentId,
    plugins,
    serverId,
    stateSource,
    toast,
    workspaceExists,
    workspaceId,
  ]);

  useCommandCenterActions({
    sourceId: serverId ? `plugins:${serverId}` : "plugins",
    enabled: Boolean(client && plugins.length > 0),
    actions,
  });
  return null;
}
