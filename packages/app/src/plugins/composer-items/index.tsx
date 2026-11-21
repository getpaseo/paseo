import { useMemo, useSyncExternalStore } from "react";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { PluginComposerProvider } from "@getpaseo/plugin/client/host";
import { withUnistyles } from "react-native-unistyles";
import {
  ComposerControlSurfaceProvider,
  type ComposerControlSurface,
} from "@/composer/agent-controls/composer-control";
import { showsComposerItem, useComposerControlsScope } from "@/composer/controls-scope";
import { useComposerModel } from "@/composer/model";
import { PluginItemList, pluginThemeMapping, usePluginItemHost } from "../item-host";
import { PluginEnvironmentProvider } from "../popover";
import { useInstalledPlugins } from "../registry";
import type { InstalledPlugin } from "../types";
import { toPluginComposer } from "./model";

interface ServerPluginItems {
  plugin: InstalledPlugin;
  items: InstalledPlugin["composerItems"];
}

/** The host's plugins with the composer items the surrounding composer shows. */
function useServerPlugins(serverId: string | null): ServerPluginItems[] {
  const installed = useInstalledPlugins();
  const { items: scope } = useComposerControlsScope();
  return useMemo(() => {
    if (serverId === null) return [];
    const entries: ServerPluginItems[] = [];
    for (const plugin of installed) {
      if (plugin.serverId !== serverId) continue;
      const items = plugin.composerItems.filter((item) =>
        showsComposerItem(scope, plugin.id, item.id),
      );
      if (items.length > 0) entries.push({ plugin, items });
    }
    return entries;
  }, [installed, scope, serverId]);
}

/** How many composer items the host's plugins registered, whether or not each renders anything. */
export function usePluginComposerItemCount(serverId: string | null): number {
  const plugins = useServerPlugins(serverId);
  return plugins.reduce((count, entry) => count + entry.items.length, 0);
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
      {plugins.map(({ plugin, items }) => (
        <ThemedPluginComposerItems
          key={plugin.id}
          plugin={plugin}
          items={items}
          uniProps={pluginThemeMapping}
        />
      ))}
    </ComposerControlSurfaceProvider>
  );
}

function PluginComposerItemsHost({
  plugin,
  items,
  theme,
}: {
  plugin: InstalledPlugin;
  items: InstalledPlugin["composerItems"];
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
        <PluginItemList plugin={plugin} items={items} props={props} />
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
