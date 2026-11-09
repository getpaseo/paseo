import { useMemo, type ComponentType } from "react";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-api-context";
import { useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { createPluginClientStateSource } from "./client-state/source";
import { resolvePluginPlatform } from "./platform";
import type { PluginEnvironment } from "./popover";
import { SurfaceErrorBoundary } from "./surface-error-boundary";
import { toPluginTheme } from "./theme";
import type { InstalledPlugin } from "./types";

/** `withUnistyles` mapping that hands a host the plugin theme. */
export const pluginThemeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });

function renderNothing() {
  return null;
}

/** What a plugin's items on a host surface (composer, New workspace) share: environment and props. */
export function usePluginItemHost(
  plugin: InstalledPlugin,
  theme: PluginHostProps["theme"],
): { environment: PluginEnvironment; props: PluginHostProps } {
  const toast = useToast();
  const compact = useIsCompactFormFactor();
  const hosts = useHosts();
  const hostLabel =
    hosts.find((host) => host.serverId === plugin.serverId)?.label ?? plugin.serverId;
  const environment = useMemo<PluginEnvironment>(
    () => ({
      installation: plugin,
      toast,
      state: createPluginClientStateSource(plugin.serverId),
    }),
    [plugin, toast],
  );
  const props = useMemo<PluginHostProps>(
    () => ({
      theme,
      host: { id: plugin.serverId, label: hostLabel },
      layout: { compact, platform: resolvePluginPlatform() },
    }),
    [compact, hostLabel, plugin.serverId, theme],
  );
  return { environment, props };
}

/** Mounts each item behind its own boundary; a throwing item draws nothing. */
export function PluginItemList({
  plugin,
  items,
  props,
}: {
  plugin: InstalledPlugin;
  items: readonly { id: string; Component: ComponentType<PluginHostProps> }[];
  props: PluginHostProps;
}) {
  return (
    <>
      {items.map(({ id, Component }) => (
        <SurfaceErrorBoundary
          key={id}
          installation={plugin}
          Surface={Component}
          renderError={renderNothing}
        >
          <Component {...props} />
        </SurfaceErrorBoundary>
      ))}
    </>
  );
}
