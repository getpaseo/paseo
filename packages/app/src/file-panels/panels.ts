import { useMemo } from "react";
import { useInstalledPlugins } from "@/plugins/registry";
import type { PluginFilePanelContribution, InstalledPlugin } from "@/plugins/types";
import { filePanelCatalog, type RenderingFilePanel, type SourceFilePanel } from "./catalog";

export interface PluginFilePanel {
  id: string;
  builtin: false;
  files: PluginFilePanelContribution["files"];
  plugin: InstalledPlugin;
  contribution: PluginFilePanelContribution;
}
export type FilePanel = RenderingFilePanel | PluginFilePanel | SourceFilePanel;

export function useFilePanels(serverId: string): readonly FilePanel[] {
  const plugins = useInstalledPlugins();
  return useMemo(
    () => hostFilePanels(plugins.filter((plugin) => plugin.serverId === serverId)),
    [plugins, serverId],
  );
}

/** Every host's panels; a plugin installed on several hosts contributes its panels once per host. */
export function useAllHostsFilePanels(): readonly FilePanel[] {
  const plugins = useInstalledPlugins();
  return useMemo(() => hostFilePanels(plugins), [plugins]);
}

function hostFilePanels(plugins: readonly InstalledPlugin[]): readonly FilePanel[] {
  return filePanelCatalog<PluginFilePanel>(
    plugins.flatMap((plugin) =>
      plugin.filePanels.map((contribution) => ({
        id: `plugin:${plugin.id}/${contribution.id}`,
        builtin: false,
        files: contribution.files,
        plugin,
        contribution,
      })),
    ),
  );
}
