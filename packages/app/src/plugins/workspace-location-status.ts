import { useMemo } from "react";
import type {
  PluginWorkspaceLocationState,
  PluginWorkspaceLocationStatus,
  PluginWorkspaceLocationStatusProvider,
} from "@getpaseo/plugin/client";
import {
  type HostRuntimeConnectionStatus,
  useHostRuntimeConnectionStatuses,
} from "@/runtime/host-runtime";
import { useInstalledPlugins } from "./registry";
import type { InstalledPlugin } from "./types";
import { useFetchQueries } from "@/data/query";

const REFRESH_INTERVAL_MS = 30_000;
const VALID_STATES = new Set<PluginWorkspaceLocationState>([
  "online",
  "connecting",
  "offline",
  "error",
  "unknown",
]);

interface WorkspaceLocationProject {
  projectSecondaryLabel?: string | null;
  hosts: readonly { serverId: string }[];
  workspaces: readonly { serverId: string; workspaceId: string }[];
}

interface StatusProviderTarget {
  serverId: string;
  workspaceId: string;
  providers: readonly {
    pluginId: string;
    provider: PluginWorkspaceLocationStatusProvider;
  }[];
}

function providersForServer(
  installedPlugins: readonly InstalledPlugin[],
  serverId: string,
): StatusProviderTarget["providers"] {
  const providers: Array<StatusProviderTarget["providers"][number]> = [];
  for (const plugin of installedPlugins) {
    if (plugin.serverId !== serverId) continue;
    for (const provider of plugin.workspaceLocationStatusProviders) {
      providers.push({ pluginId: plugin.id, provider });
    }
  }
  return providers;
}

export interface WorkspaceLocationStatus extends PluginWorkspaceLocationStatus {}

function normalizeStatus(value: PluginWorkspaceLocationStatus): PluginWorkspaceLocationStatus {
  if (!VALID_STATES.has(value.state)) {
    throw new Error(`Invalid workspace location state: ${String(value.state)}`);
  }
  const detail = value.detail?.trim();
  return detail ? { state: value.state, detail } : { state: value.state };
}

export async function resolvePluginWorkspaceLocationStatus(
  target: StatusProviderTarget,
): Promise<PluginWorkspaceLocationStatus | null> {
  let firstError: string | null = null;
  for (const { pluginId, provider } of target.providers) {
    try {
      const status = await provider.getStatus({ workspaceId: target.workspaceId });
      if (status) return normalizeStatus(status);
    } catch (error) {
      firstError ??= `${pluginId}/${provider.id}: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }
  return firstError ? { state: "error", detail: firstError } : null;
}

function locationStateFromHost(status: HostRuntimeConnectionStatus): PluginWorkspaceLocationState {
  if (status === "online") return "online";
  if (status === "connecting") return "connecting";
  if (status === "error") return "error";
  if (status === "offline") return "offline";
  return "unknown";
}

export function aggregateWorkspaceLocationStatuses(
  statuses: readonly PluginWorkspaceLocationStatus[],
): WorkspaceLocationStatus {
  const first = (state: PluginWorkspaceLocationState) =>
    statuses.find((status) => status.state === state);
  return (
    first("online") ??
    first("connecting") ??
    first("error") ??
    first("offline") ??
    first("unknown") ?? { state: "unknown" }
  );
}

export function useWorkspaceLocationStatus(
  project: WorkspaceLocationProject,
): WorkspaceLocationStatus {
  const enabled = Boolean(project.projectSecondaryLabel);
  const serverIds = useMemo(
    () => [...new Set(project.hosts.map((host) => host.serverId))],
    [project.hosts],
  );
  const hostStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const installedPlugins = useInstalledPlugins();
  const targets = useMemo<StatusProviderTarget[]>(() => {
    if (!enabled) return [];
    const workspaceByServer = new Map<string, string>();
    for (const workspace of project.workspaces) {
      if (!workspaceByServer.has(workspace.serverId)) {
        workspaceByServer.set(workspace.serverId, workspace.workspaceId);
      }
    }
    return serverIds.flatMap((serverId) => {
      const workspaceId = workspaceByServer.get(serverId);
      if (!workspaceId) return [];
      const providers = providersForServer(installedPlugins, serverId);
      return providers.length > 0 ? [{ serverId, workspaceId, providers }] : [];
    });
  }, [enabled, installedPlugins, project.workspaces, serverIds]);
  const results = useFetchQueries(
    targets.map((target) => ({
      queryKey: [
        "plugin-workspace-location-status",
        target.serverId,
        target.workspaceId,
        target.providers.map(({ pluginId, provider }) => `${pluginId}/${provider.id}`),
      ],
      queryFn: () => resolvePluginWorkspaceLocationStatus(target),
      dataShape: "value" as const,
      enabled: hostStatuses.get(target.serverId) === "online",
      retry: false,
      staleTimeMs: REFRESH_INTERVAL_MS / 2,
      refetchInterval: REFRESH_INTERVAL_MS,
      refetchIntervalInBackground: false,
    })),
  );

  return useMemo(() => {
    if (!enabled) return { state: "unknown" };
    const resultByServer = new Map(
      targets.map((target, index) => [target.serverId, results[index]]),
    );
    const statuses = serverIds.map((serverId): PluginWorkspaceLocationStatus => {
      const hostState = locationStateFromHost(hostStatuses.get(serverId) ?? "idle");
      if (hostState !== "online") return { state: hostState };
      const result = resultByServer.get(serverId);
      if (!result) return { state: "online" };
      if (result.data) return result.data;
      if (result.isPending || result.isFetching) return { state: "connecting" };
      if (result.error) {
        return {
          state: "error",
          detail: result.error instanceof Error ? result.error.message : String(result.error),
        };
      }
      return { state: "online" };
    });
    return aggregateWorkspaceLocationStatuses(statuses);
  }, [enabled, hostStatuses, results, serverIds, targets]);
}
