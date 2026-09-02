import { usePathname } from "expo-router";
import { useMemo } from "react";
import { useCommandCenterActions } from "@/command-center/provider";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceExists } from "@/stores/session-store-hooks";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import { createPluginClientStateSource } from "../client-state/source";
import { hostIdFromPathname } from "../routes";
import { useInstalledPlugins } from "../registry";
import { createPluginSurfaceRuntime } from "../surface-runtime";
import { buildPluginCommandCenterContributions } from "./contributions";
import { getFocusedAgentId } from "./context";
import { createPluginNavigation } from "../navigation";

export function PluginCommandCenterActions() {
  const pathname = usePathname();
  const selection = useActiveWorkspaceSelection();
  const serverId = selection?.serverId ?? hostIdFromPathname(pathname);
  const workspaceId = selection?.workspaceId ?? null;
  const workspaceExists = useWorkspaceExists(serverId, workspaceId);
  const workspaceKey = serverId && workspaceId ? `${serverId}:${workspaceId}` : null;
  const layout = useWorkspaceLayoutStore((state) =>
    workspaceKey ? (state.layoutByWorkspace[workspaceKey] ?? null) : null,
  );
  const focusedAgentId = getFocusedAgentId(layout);
  const agentExists = useSessionStore((state) => {
    if (!serverId || !focusedAgentId) return null;
    const session = state.sessions[serverId];
    const agent =
      session?.agents.get(focusedAgentId) ?? session?.agentDetails.get(focusedAgentId) ?? null;
    return (
      Boolean(agent) &&
      Boolean(workspaceId) &&
      normalizeWorkspaceOpaqueId(agent?.workspaceId) === normalizeWorkspaceOpaqueId(workspaceId)
    );
  });
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
      navigation: createPluginNavigation({ serverId, workspaceId }),
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
