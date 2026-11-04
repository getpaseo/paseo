import { usePathname } from "expo-router";
import { useEffect, useMemo } from "react";
import { useCommandCenterActions } from "@/command-center/provider";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceExists } from "@/stores/session-store-hooks";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import { createPluginClientStateSource } from "../client-state/source";
import { publishFocusedAgent } from "../focused-agent";
import { hostIdFromPathname } from "../routes";
import { useInstalledPlugins } from "../registry";
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
  const handedAgentId = agentExists ? focusedAgentId : null;
  // The agent a plugin's `{ focused: true }` composer names is the one handed to agent items.
  // Known limit: this publishes in an effect, so a command that runs on the first commit after a
  // route change can still see the previous route's agent. Publishing from a shared
  // navigation/focus context would remove the gap.
  useEffect(() => {
    publishFocusedAgent(serverId && handedAgentId ? { serverId, agentId: handedAgentId } : null);
    return () => publishFocusedAgent(null);
  }, [handedAgentId, serverId]);
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
      state: stateSource,
      workspaceId: workspaceExists ? workspaceId : null,
      agentId: handedAgentId,
      navigation: createPluginNavigation({ serverId, workspaceId }),
      reportError(error) {
        toast.error(error instanceof Error ? error.message : String(error));
      },
    });
  }, [client, handedAgentId, plugins, serverId, stateSource, toast, workspaceExists, workspaceId]);

  useCommandCenterActions({
    sourceId: serverId ? `plugins:${serverId}` : "plugins",
    enabled: Boolean(client && plugins.length > 0),
    actions,
  });
  return null;
}
