import { useMemo } from "react";
import type {
  PluginAgentCommandContext,
  PluginClientSlashCommandContribution,
  PluginClientSlashCommandProviderContribution,
  PluginWorkspaceCommandContext,
} from "@getpaseo/plugin/client";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useFetchQueries } from "@/data/query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { createPluginAgentActionContext, createPluginWorkspaceActionContext } from "../actions";
import { createPluginClientStateSource } from "../client-state/source";
import { createPluginNavigation } from "../navigation";
import { useInstalledPlugins } from "../registry";
import { createPluginSurfaceRuntime } from "../surface-runtime";
import type { InstalledPlugin } from "../types";
import {
  flattenPluginSlashCommandGroups,
  normalizePluginSlashCommandProviderCommands,
} from "./model";
import { pluginSlashCommandProviderQueryKey } from "./query";

const PROVIDER_COMMANDS_STALE_TIME_MS = 5_000;
const installationKeys = new WeakMap<InstalledPlugin, string>();
let nextInstallationKey = 1;

export interface PluginClientSlashCommand {
  pluginId: string;
  name: string;
  description: string;
  argumentHint: string;
  run(args: string): Promise<void>;
}

export interface PluginClientSlashCommandsState {
  commands: PluginClientSlashCommand[];
  isLoading: boolean;
  error: Error | null;
}

interface SlashCommandProviderRequest {
  key: readonly string[];
  load(): Promise<PluginClientSlashCommand[]>;
}

interface SlashCommandPluginGroup {
  staticCommands: PluginClientSlashCommand[];
  providerIndexes: number[];
}

interface ResolvedSlashCommandContributions {
  groups: SlashCommandPluginGroup[];
  providers: SlashCommandProviderRequest[];
}

function installationKey(plugin: InstalledPlugin): string {
  const existing = installationKeys.get(plugin);
  if (existing) return existing;
  const key = `${plugin.serverId}/${plugin.id}/${nextInstallationKey++}`;
  installationKeys.set(plugin, key);
  return key;
}

function staticWorkspaceCommand(input: {
  pluginId: string;
  contribution: Extract<PluginClientSlashCommandContribution, { context: "workspace" }>;
  context: PluginWorkspaceCommandContext;
}): PluginClientSlashCommand {
  return {
    pluginId: input.pluginId,
    name: input.contribution.name,
    description: input.contribution.description,
    argumentHint: input.contribution.argumentHint,
    async run(args) {
      await input.contribution.onSubmit({ ...input.context, args });
    },
  };
}

function staticAgentCommand(input: {
  pluginId: string;
  contribution: Extract<PluginClientSlashCommandContribution, { context: "agent" }>;
  context: PluginAgentCommandContext;
}): PluginClientSlashCommand {
  return {
    pluginId: input.pluginId,
    name: input.contribution.name,
    description: input.contribution.description,
    argumentHint: input.contribution.argumentHint,
    async run(args) {
      await input.contribution.onSubmit({ ...input.context, args });
    },
  };
}

function workspaceProviderRequest(input: {
  serverId: string;
  pluginId: string;
  installationKey: string;
  provider: Extract<PluginClientSlashCommandProviderContribution, { context: "workspace" }>;
  context: PluginWorkspaceCommandContext;
}): SlashCommandProviderRequest {
  return {
    key: [
      ...pluginSlashCommandProviderQueryKey(input.serverId, input.pluginId),
      input.installationKey,
      input.provider.id,
      input.context.workspace.id,
      input.context.workspace.directory,
      input.context.workspace.projectRootPath,
    ],
    async load() {
      const listed = await input.provider.list(input.context);
      const commands = normalizePluginSlashCommandProviderCommands({
        pluginId: input.pluginId,
        providerId: input.provider.id,
        commands: listed,
      });
      return commands.map((command) => ({
        pluginId: input.pluginId,
        name: command.name,
        description: command.description,
        argumentHint: command.argumentHint,
        async run(args: string) {
          await input.provider.onSubmit({ ...input.context, command, args });
        },
      }));
    },
  };
}

function agentProviderRequest(input: {
  serverId: string;
  pluginId: string;
  installationKey: string;
  provider: Extract<PluginClientSlashCommandProviderContribution, { context: "agent" }>;
  context: PluginAgentCommandContext;
}): SlashCommandProviderRequest {
  return {
    key: [
      ...pluginSlashCommandProviderQueryKey(input.serverId, input.pluginId),
      input.installationKey,
      input.provider.id,
      input.context.workspace.id,
      input.context.workspace.directory,
      input.context.workspace.projectRootPath,
      input.context.agent.id,
      input.context.agent.provider,
      input.context.agent.cwd,
      input.context.agent.model ?? "",
      input.context.agent.currentModeId ?? "",
      input.context.agent.thinkingOptionId ?? "",
    ],
    async load() {
      const listed = await input.provider.list(input.context);
      const commands = normalizePluginSlashCommandProviderCommands({
        pluginId: input.pluginId,
        providerId: input.provider.id,
        commands: listed,
      });
      return commands.map((command) => ({
        pluginId: input.pluginId,
        name: command.name,
        description: command.description,
        argumentHint: command.argumentHint,
        async run(args: string) {
          await input.provider.onSubmit({ ...input.context, command, args });
        },
      }));
    },
  };
}

export function usePluginClientSlashCommands(input: {
  serverId: string;
  workspaceId: string | null | undefined;
  agentId: string;
}): PluginClientSlashCommandsState {
  const client = useHostRuntimeClient(input.serverId);
  const installed = useInstalledPlugins();
  const retainedPanelActive = useRetainedPanelActive();
  const resolved = useMemo<ResolvedSlashCommandContributions>(() => {
    const groups: SlashCommandPluginGroup[] = [];
    const providers: SlashCommandProviderRequest[] = [];
    if (!client || !input.workspaceId) return { groups, providers };

    const workspaceId = input.workspaceId;
    const state = createPluginClientStateSource(input.serverId);
    const navigation = createPluginNavigation({ serverId: input.serverId, workspaceId });
    for (const plugin of installed) {
      if (plugin.serverId !== input.serverId) continue;
      const runtime = createPluginSurfaceRuntime(client, plugin.id);
      if (!runtime) continue;
      const staticCommands: PluginClientSlashCommand[] = [];
      const providerIndexes: number[] = [];
      const currentInstallationKey = installationKey(plugin);
      const workspaceContext = createPluginWorkspaceActionContext({
        plugin,
        runtime,
        navigation,
        state,
        workspaceId,
      });
      const agentContext = createPluginAgentActionContext({
        plugin,
        runtime,
        navigation,
        state,
        workspaceId,
        agentId: input.agentId,
      });

      for (const contribution of plugin.clientSlashCommands) {
        if (contribution.context === "workspace" && workspaceContext) {
          staticCommands.push(
            staticWorkspaceCommand({
              pluginId: plugin.id,
              contribution,
              context: workspaceContext,
            }),
          );
        }
        if (contribution.context === "agent" && agentContext) {
          staticCommands.push(
            staticAgentCommand({ pluginId: plugin.id, contribution, context: agentContext }),
          );
        }
      }

      for (const provider of plugin.clientSlashCommandProviders) {
        if (provider.context === "workspace" && workspaceContext) {
          providerIndexes.push(providers.length);
          providers.push(
            workspaceProviderRequest({
              serverId: input.serverId,
              pluginId: plugin.id,
              installationKey: currentInstallationKey,
              provider,
              context: workspaceContext,
            }),
          );
        }
        if (provider.context === "agent" && agentContext) {
          providerIndexes.push(providers.length);
          providers.push(
            agentProviderRequest({
              serverId: input.serverId,
              pluginId: plugin.id,
              installationKey: currentInstallationKey,
              provider,
              context: agentContext,
            }),
          );
        }
      }
      if (staticCommands.length > 0 || providerIndexes.length > 0) {
        groups.push({ staticCommands, providerIndexes });
      }
    }
    return { groups, providers };
  }, [client, input.agentId, input.serverId, input.workspaceId, installed]);

  const queries = useFetchQueries(
    resolved.providers.map((provider) => ({
      queryKey: provider.key,
      queryFn: provider.load,
      enabled: retainedPanelActive,
      retry: false,
      gcTime: 0,
      staleTimeMs: PROVIDER_COMMANDS_STALE_TIME_MS,
      dataShape: "value" as const,
    })),
  );
  const queryError = queries.find((query) => query.error)?.error;
  const error = queryError instanceof Error ? queryError : null;
  return {
    commands: flattenPluginSlashCommandGroups({
      groups: resolved.groups,
      providerResults: queries.map((query) => query.data),
    }),
    isLoading: queries.some((query) => query.isLoading),
    error,
  };
}
