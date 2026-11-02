import { useMemo, useSyncExternalStore } from "react";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { PluginComposerProvider } from "@getpaseo/plugin/client/host";
import { withUnistyles } from "react-native-unistyles";
import {
  ComposerControlSurfaceProvider,
  type ComposerControlSurface,
} from "@/composer/agent-controls/composer-control";
import { useComposerAgent, useComposerInput } from "@/composer/session";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-api-context";
import { useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { createPluginClientStateSource } from "../client-state/source";
import { resolvePluginPlatform } from "../platform";
import { PluginEnvironmentProvider, type PluginEnvironment } from "../popover";
import { useInstalledPlugins } from "../registry";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import { toPluginTheme } from "../theme";
import type { InstalledPlugin } from "../types";
import { toPluginComposer } from "./model";

const pluginThemeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });

function renderNothing() {
  return null;
}

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
  const agent = useComposerAgent();
  const composerInput = useComposerInput();
  const toast = useToast();
  const compact = useIsCompactFormFactor();
  const hosts = useHosts();
  const hostLabel =
    hosts.find((host) => host.serverId === plugin.serverId)?.label ?? plugin.serverId;
  const textSource = composerInput?.textSource;
  const prompt = useSyncExternalStore(
    textSource?.subscribe ?? subscribeNothing,
    textSource?.getSnapshot ?? emptyText,
    textSource?.getSnapshot ?? emptyText,
  );
  const environment = useMemo<PluginEnvironment>(
    () => ({
      installation: plugin,
      toast,
      state: createPluginClientStateSource(plugin.serverId),
    }),
    [plugin, toast],
  );
  const composer = useMemo(
    () =>
      agent && composerInput ? toPluginComposer({ plugin, agent, composerInput, prompt }) : null,
    [agent, composerInput, plugin, prompt],
  );
  const props = useMemo<PluginHostProps>(
    () => ({
      theme,
      host: { id: plugin.serverId, label: hostLabel },
      layout: { compact, platform: resolvePluginPlatform() },
    }),
    [compact, hostLabel, plugin.serverId, theme],
  );
  if (!composer) return null;
  return (
    <PluginEnvironmentProvider environment={environment}>
      <PluginComposerProvider composer={composer}>
        {plugin.composerItems.map(({ id, Component }) => (
          <SurfaceErrorBoundary
            key={id}
            installation={plugin}
            Surface={Component}
            renderError={renderNothing}
          >
            <Component {...props} />
          </SurfaceErrorBoundary>
        ))}
      </PluginComposerProvider>
    </PluginEnvironmentProvider>
  );
}

const ThemedPluginComposerItems = withUnistyles(PluginComposerItemsHost);

function subscribeNothing() {
  return () => undefined;
}

function emptyText() {
  return "";
}
