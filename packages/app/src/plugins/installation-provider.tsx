import { getPluginClientApi } from "./client-state/api";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  PaseoApiProvider,
  PluginComposersProvider,
  PluginRpcProvider,
  PluginTranslationProvider,
} from "@getpaseo/plugin/client/host";
import React, { createContext, useContext, type ReactNode } from "react";
import { pluginComposersSource } from "./composer-items/source";
import type { InstalledPlugin } from "./types";

const PluginInstallationContext = createContext<InstalledPlugin | null>(null);

/** The installation whose surface is rendering, for host UI that acts on the plugin's host. */
export function usePluginInstallation(): InstalledPlugin {
  const plugin = useContext(PluginInstallationContext);
  if (!plugin) throw new Error("Plugin host UI must render inside a plugin surface");
  return plugin;
}

/** Every plugin surface renders under its installation: one query cache, one Paseo client, RPCs. */
export function PluginInstallationProvider({
  plugin,
  children,
}: {
  plugin: InstalledPlugin;
  children: ReactNode;
}) {
  return (
    <PluginInstallationContext.Provider value={plugin}>
      <QueryClientProvider client={plugin.queryClient}>
        <PaseoApiProvider paseo={getPluginClientApi(plugin).paseo}>
          <PluginRpcProvider invoke={plugin.invoke} subscribe={plugin.subscribe}>
            <PluginTranslationProvider runtime={plugin.i18n}>
              <PluginComposersProvider source={pluginComposersSource(plugin)}>
                {children}
              </PluginComposersProvider>
            </PluginTranslationProvider>
          </PluginRpcProvider>
        </PaseoApiProvider>
      </QueryClientProvider>
    </PluginInstallationContext.Provider>
  );
}
