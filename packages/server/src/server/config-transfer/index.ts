import type {
  AgentSkillSelection,
  HostConfigDocument,
  MutableDaemonConfig,
  MutableDaemonConfigPatch,
  PluginListItem,
} from "@getpaseo/protocol/messages";
import type { PersistedConfig } from "../persisted-config.js";
import { buildHostDocument } from "./internal/export.js";
import {
  applyImport,
  previewImport,
  type ApplyRequest,
  type ImportPreview,
  type ImportResult,
} from "./internal/import.js";
import type { RedactedPath } from "./internal/sections.js";

export interface ConfigTransferDependencies {
  daemonVersion: string;
  config: {
    readPersisted(): Promise<PersistedConfig>;
    get(): MutableDaemonConfig;
    patch(patch: MutableDaemonConfigPatch): Promise<unknown>;
  };
  plugins: {
    listPlugins(): Promise<PluginListItem[]>;
    installSource(input: { source: string; id?: string; ref?: string }): Promise<PluginListItem>;
    disablePlugin(pluginId: string): Promise<unknown>;
    invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
  };
  skills?: {
    saveSelection(
      selection: AgentSkillSelection,
    ): Promise<{ confirmationRequired: { removals: string[] } | null }>;
  };
  settingsDirectory: string;
}

/**
 * Moves a host's portable configuration between daemons. Export reads the saved config through
 * an allow-list, so secrets and machine paths stay behind; import writes only through the config
 * store, the plugin installer, and each plugin's own settings validation.
 */
export interface ConfigTransfer {
  exportDocument(): Promise<HostConfigDocument>;
  previewImport(document: HostConfigDocument): Promise<ImportPreview>;
  applyImport(request: ApplyRequest): Promise<{ results: ImportResult[]; reenter: RedactedPath[] }>;
}

export function createConfigTransfer(dependencies: ConfigTransferDependencies): ConfigTransfer {
  const { config, plugins, skills } = dependencies;
  const ports = {
    readTarget: async () => ({ persisted: await config.readPersisted(), live: config.get() }),
    patch: (patch: MutableDaemonConfigPatch) => config.patch(patch),
    saveSkillSelection: (selection: AgentSkillSelection) => {
      if (!skills) throw new Error("Skill management is unavailable on this host");
      return skills.saveSelection(selection);
    },
    installPlugin: (input: { source: string; id: string; ref?: string }) =>
      plugins.installSource(input),
    disablePlugin: (pluginId: string) => plugins.disablePlugin(pluginId),
    invokePluginRpc: (pluginId: string, method: string, input: unknown) =>
      plugins.invokePluginRpc(pluginId, method, input),
  };
  return {
    exportDocument: async () =>
      buildHostDocument({
        daemonVersion: dependencies.daemonVersion,
        persisted: await config.readPersisted(),
        plugins: await plugins.listPlugins(),
        settingsDirectory: dependencies.settingsDirectory,
      }),
    previewImport: (document) => previewImport(document, ports),
    applyImport: (request) => applyImport(request, ports),
  };
}
