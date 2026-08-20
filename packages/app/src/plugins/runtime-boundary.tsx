import { QueryClientProvider } from "@tanstack/react-query";
import { PaseoApiProvider, PluginEventProvider, PluginRpcProvider } from "@getpaseo/plugin/host";
import type { ReactNode } from "react";
import type { InstalledPlugin } from "./types";
import type { PluginSurfaceRuntime } from "./surface-runtime";

export function PluginRuntimeBoundary({
  plugin,
  runtime,
  children,
}: {
  plugin: InstalledPlugin;
  runtime: PluginSurfaceRuntime;
  children: ReactNode;
}) {
  return (
    <QueryClientProvider client={plugin.queryClient}>
      <PaseoApiProvider paseo={runtime.paseo}>
        <PluginRpcProvider invoke={runtime.invoke}>
          <PluginEventProvider on={runtime.on}>{children}</PluginEventProvider>
        </PluginRpcProvider>
      </PaseoApiProvider>
    </QueryClientProvider>
  );
}
