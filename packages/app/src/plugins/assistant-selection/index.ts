import { useMemo } from "react";
import type { PluginAssistantSelection } from "@getpaseo/plugin/client";
import { createPluginAgentActionContext } from "../actions";
import { createPluginClientStateSource } from "../client-state/source";
import { createPluginNavigation } from "../navigation";
import { useInstalledPlugins } from "../registry";
import { dedupeAssistantSelectionActions } from "./model";

export interface PluginAssistantSelectionAction {
  pluginId: string;
  id: string;
  title: string;
  run(selection: PluginAssistantSelection): Promise<void>;
}

export function usePluginAssistantSelectionActions(input: {
  serverId: string;
  workspaceId: string | null | undefined;
  agentId: string;
}): PluginAssistantSelectionAction[] {
  const installed = useInstalledPlugins();
  const { agentId, serverId, workspaceId } = input;
  return useMemo(() => {
    if (!workspaceId) return [];
    const state = createPluginClientStateSource(serverId);
    const navigation = createPluginNavigation({ serverId, workspaceId });
    const actions = installed
      .filter((plugin) => plugin.serverId === serverId)
      .flatMap((plugin) =>
        plugin.assistantSelectionActions.map((contribution) => ({
          pluginId: plugin.id,
          id: contribution.id,
          title: plugin.i18n.resolve(contribution.title, plugin.locale),
          async run(selection: PluginAssistantSelection) {
            const context = createPluginAgentActionContext({
              plugin,
              navigation,
              state,
              workspaceId,
              agentId,
            });
            if (context) await contribution.onSelect({ ...context, selection });
          },
        })),
      );
    return dedupeAssistantSelectionActions(actions, (action) => {
      console.warn(
        `Ignoring duplicate assistant selection title from ${action.pluginId}: ${action.title}`,
      );
    });
  }, [agentId, installed, serverId, workspaceId]);
}
