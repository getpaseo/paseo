import { QueryClientProvider } from "@tanstack/react-query";
import {
  PaseoApiProvider,
  PluginRpcProvider,
  PluginTranslationProvider,
} from "@getpaseo/plugin/client/host";
import React, { type ReactNode } from "react";
import type { InstalledPlugin } from "./types";

/** Every plugin surface renders under its installation: one query cache, one Paseo client, RPCs. */
export function PluginInstallationProvider({
  plugin,
  children,
}: {
  plugin: InstalledPlugin;
  children: ReactNode;
}) {
  return (
    <QueryClientProvider client={plugin.queryClient}>
      <PaseoApiProvider paseo={plugin.paseo}>
        <PluginRpcProvider invoke={plugin.invoke}>
          <PluginTranslationProvider runtime={plugin.i18n}>{children}</PluginTranslationProvider>
        </PluginRpcProvider>
      </PaseoApiProvider>
    </QueryClientProvider>
  );
}
