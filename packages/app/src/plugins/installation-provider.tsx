import { getPluginClientApi } from "./client-state/api";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  PaseoApiProvider,
  PluginClientStateProvider,
  PluginComposersProvider,
  PluginRpcProvider,
  PluginTranslationProvider,
  type PluginClientStateSource,
} from "@getpaseo/plugin/client/host";
import React, { useMemo, type ReactNode } from "react";
import { createPluginClientStateSource } from "./client-state/source";
import { pluginComposersSource } from "./composer-items/source";
import type { InstalledPlugin } from "./types";

/**
 * Every plugin surface renders under its installation: one query cache, one Paseo client, RPCs,
 * and the state the plugin state hooks read. That state is scoped to the installation's host
 * unless the surface passes its own, as a sidebar view does to span every connected host.
 */
export function PluginInstallationProvider({
  plugin,
  state: surfaceState,
  children,
}: {
  plugin: InstalledPlugin;
  state?: PluginClientStateSource;
  children: ReactNode;
}) {
  const state = useMemo(
    () => surfaceState ?? createPluginClientStateSource(plugin.serverId),
    [plugin.serverId, surfaceState],
  );
  return (
    <QueryClientProvider client={plugin.queryClient}>
      <PaseoApiProvider paseo={getPluginClientApi(plugin).paseo}>
        <PluginRpcProvider invoke={plugin.invoke} subscribe={plugin.subscribe}>
          <PluginTranslationProvider runtime={plugin.i18n}>
            <PluginComposersProvider source={pluginComposersSource(plugin)}>
              <PluginClientStateProvider source={state}>{children}</PluginClientStateProvider>
            </PluginComposersProvider>
          </PluginTranslationProvider>
        </PluginRpcProvider>
      </PaseoApiProvider>
    </QueryClientProvider>
  );
}
