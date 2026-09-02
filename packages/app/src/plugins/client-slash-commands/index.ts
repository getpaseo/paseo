import { useMemo } from "react";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { createPluginAgentActionContext, createPluginWorkspaceActionContext } from "../actions";
import { createPluginClientStateSource } from "../client-state/source";
import { createPluginNavigation } from "../navigation";
import { useInstalledPlugins } from "../registry";
import { createPluginSurfaceRuntime } from "../surface-runtime";

export interface PluginClientSlashCommand {
  pluginId: string;
  name: string;
  description: string;
  argumentHint: string;
  run(args: string): Promise<void>;
}

export function usePluginClientSlashCommands(input: {
  serverId: string;
  workspaceId: string | null | undefined;
  agentId: string;
}): PluginClientSlashCommand[] {
  const client = useHostRuntimeClient(input.serverId);
  const installed = useInstalledPlugins();
  return useMemo(() => {
    if (!client || !input.workspaceId) return [];
    const workspaceId = input.workspaceId;
    const state = createPluginClientStateSource(input.serverId);
    const navigation = createPluginNavigation({
      serverId: input.serverId,
      workspaceId,
    });
    const commands = installed
      .filter((plugin) => plugin.serverId === input.serverId)
      .flatMap((plugin) => {
        const runtime = createPluginSurfaceRuntime(client, plugin.id);
        if (!runtime) return [];
        return (plugin.clientSlashCommands ?? []).flatMap((contribution) => {
          const context =
            contribution.context === "agent"
              ? createPluginAgentActionContext({
                  plugin,
                  runtime,
                  navigation,
                  state,
                  workspaceId,
                  agentId: input.agentId,
                })
              : createPluginWorkspaceActionContext({
                  plugin,
                  runtime,
                  navigation,
                  state,
                  workspaceId,
                });
          if (!context) return [];
          return [
            {
              pluginId: plugin.id,
              name: contribution.name,
              description: contribution.description,
              argumentHint: contribution.argumentHint,
              async run(args: string) {
                if (contribution.context === "agent" && context.context === "agent") {
                  await contribution.onSubmit({ ...context, args });
                } else if (
                  contribution.context === "workspace" &&
                  context.context === "workspace"
                ) {
                  await contribution.onSubmit({ ...context, args });
                }
              },
            },
          ];
        });
      });
    return commands;
  }, [client, input.agentId, input.serverId, input.workspaceId, installed]);
}
