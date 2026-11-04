import { useMemo, useSyncExternalStore } from "react";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { PluginComposerProvider } from "@getpaseo/plugin/client/host";
import { withUnistyles } from "react-native-unistyles";
import {
  ComposerControlSurfaceProvider,
  type ComposerControlSurface,
} from "@/composer/agent-controls/composer-control";
import { useComposerModel } from "@/composer/model";
import { PluginItemList, pluginThemeMapping, usePluginItemHost } from "../item-host";
import { PluginEnvironmentProvider } from "../popover";
import { useInstalledPlugins } from "../registry";
import type { InstalledPlugin } from "../types";
import { toPluginComposer } from "./model";

function useServerPlugins(serverId: string | null): InstalledPlugin[] {
  const installed = useInstalledPlugins();
  return useMemo(
    () =>
      serverId === null
        ? []
        : installed.filter(
            (plugin) => plugin.serverId === serverId && plugin.composerItems.length > 0,
          ),
    [installed, serverId],
  );
}

/** How many composer items the host's plugins registered; the toolbar budgets room for them. */
export function usePluginComposerItemCount(serverId: string | null): number {
  const plugins = useServerPlugins(serverId);
  return plugins.reduce((count, plugin) => count + plugin.composerItems.length, 0);
}

/**
 * The host's plugin composer items. They read and command the composer they are mounted in, so
 * they render only where a composer provides its input and agent.
 */
export function PluginComposerItems({
  serverId,
  surface,
}: {
  serverId: string | null;
  surface: ComposerControlSurface;
}) {
  const plugins = useServerPlugins(serverId);
  if (serverId === null || plugins.length === 0) return null;
  return (
    <ComposerControlSurfaceProvider value={surface}>
      {plugins.map((plugin) => (
        <ThemedPluginComposerItems key={plugin.id} plugin={plugin} uniProps={pluginThemeMapping} />
      ))}
    </ComposerControlSurfaceProvider>
  );
}

function PluginComposerItemsHost({
  plugin,
  theme,
}: {
  plugin: InstalledPlugin;
  theme: PluginHostProps["theme"];
}) {
  const model = useComposerModel();
  const { environment, props } = usePluginItemHost(plugin, theme);
  const state = useSyncExternalStore(
    model?.subscribe ?? subscribeNothing,
    model ? model.getState : noState,
    model ? model.getState : noState,
  );
  const composer = useMemo(
    () => (model && state ? toPluginComposer({ plugin, model, state }) : null),
    [model, plugin, state],
  );
  if (!composer) return null;
  return (
    <PluginEnvironmentProvider environment={environment}>
      <PluginComposerProvider composer={composer}>
        <PluginItemList plugin={plugin} items={plugin.composerItems} props={props} />
      </PluginComposerProvider>
    </PluginEnvironmentProvider>
  );
}

const ThemedPluginComposerItems = withUnistyles(PluginComposerItemsHost);

function subscribeNothing() {
  return () => undefined;
}

function noState(): null {
  return null;
}
