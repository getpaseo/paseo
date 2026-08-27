import { QueryClientProvider } from "@tanstack/react-query";
import {
  PaseoApiProvider,
  PluginNavigationProvider,
  PluginProjectProvider,
  PluginRpcProvider,
} from "@getpaseo/plugin/host";
import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
import { useCallback, useMemo, useRef, type ReactNode } from "react";
import { useProjects } from "@/hooks/use-projects";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { toPluginProjectSnapshots } from "./project-catalog";
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
  const { projects } = useProjects();
  const projectSnapshots = useMemo(() => toPluginProjectSnapshots(projects), [projects]);
  const paseoByServerId = useRef(new Map<string, { client: object; paseo: PaseoApi }>());
  const resolvePaseo = useCallback((serverId: string): PaseoApi | null => {
    const snapshot = getHostRuntimeStore().getSnapshot(serverId);
    if (snapshot?.connectionStatus !== "online" || !snapshot.client) return null;
    const cached = paseoByServerId.current.get(serverId);
    if (cached?.client === snapshot.client) return cached.paseo;
    const paseo = createPaseoApi(snapshot.client);
    paseoByServerId.current.set(serverId, { client: snapshot.client, paseo });
    return paseo;
  }, []);
  return (
    <QueryClientProvider client={plugin.queryClient}>
      <PaseoApiProvider paseo={runtime.paseo}>
        <PluginProjectProvider projects={projectSnapshots} resolvePaseo={resolvePaseo}>
          <PluginRpcProvider invoke={runtime.invoke}>
            <PluginNavigationProvider navigation={runtime.navigation}>
              {children}
            </PluginNavigationProvider>
          </PluginRpcProvider>
        </PluginProjectProvider>
      </PaseoApiProvider>
    </QueryClientProvider>
  );
}
