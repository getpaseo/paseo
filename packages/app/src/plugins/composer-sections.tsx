import { useMemo } from "react";
import type { PluginComposerSectionProps } from "@getpaseo/plugin/client";
import { withUnistyles } from "react-native-unistyles";
import { PluginItemList, pluginThemeMapping, usePluginItemHost } from "./item-host";
import { PluginEnvironmentProvider } from "./popover";
import { useInstalledPlugins } from "./registry";
import type { InstalledPlugin } from "./types";

interface ComposerSectionTarget {
  serverId: string;
  workspaceId: string;
  agentId: string;
}

/** Separate from the toolbar: null content reserves no track or input space. */
export function PluginComposerSections(target: ComposerSectionTarget) {
  const installed = useInstalledPlugins();
  const plugins = useMemo(
    () =>
      installed.filter(
        (plugin) => plugin.serverId === target.serverId && plugin.composerSections.length > 0,
      ),
    [installed, target.serverId],
  );
  return plugins.map((plugin) => (
    <ThemedComposerSections
      key={`${plugin.id}:${target.agentId}`}
      plugin={plugin}
      workspaceId={target.workspaceId}
      agentId={target.agentId}
      uniProps={pluginThemeMapping}
    />
  ));
}

function ComposerSectionsHost({
  plugin,
  workspaceId,
  agentId,
  theme,
}: {
  plugin: InstalledPlugin;
  workspaceId: string;
  agentId: string;
  theme: PluginComposerSectionProps["theme"];
}) {
  const { environment, props } = usePluginItemHost(plugin, theme);
  const sectionProps = useMemo<PluginComposerSectionProps>(
    () => ({ ...props, workspaceId, agentId }),
    [props, workspaceId, agentId],
  );
  return (
    <PluginEnvironmentProvider environment={environment}>
      <PluginItemList plugin={plugin} items={plugin.composerSections} props={sectionProps} />
    </PluginEnvironmentProvider>
  );
}

const ThemedComposerSections = withUnistyles(ComposerSectionsHost);
