import { QueryClientProvider } from "@tanstack/react-query";
import { PaseoApiProvider, PluginRpcProvider } from "@getpaseo/plugin/client/host";
import type { ReactNode } from "react";
import type { InstalledPlugin } from "./types";
import { usePluginSurfaceRuntime } from "./surface-runtime";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export function PluginRuntimeBoundary({
  plugin,
  client,
  children,
}: {
  plugin: InstalledPlugin;
  client: DaemonClient;
  children: ReactNode;
}) {
  const runtime = usePluginSurfaceRuntime(client, plugin);
  if (!runtime) return null;
  return (
    <QueryClientProvider client={plugin.queryClient}>
      <PaseoApiProvider paseo={runtime.paseo}>
        <PluginRpcProvider invoke={runtime.invoke}>{children}</PluginRpcProvider>
      </PaseoApiProvider>
    </QueryClientProvider>
  );
}
