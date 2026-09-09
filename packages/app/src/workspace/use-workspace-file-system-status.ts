import { useMemo } from "react";
import type { WorkspaceFileSystemStatus } from "@getpaseo/protocol/messages";
import {
  getHostRuntimeStore,
  type HostRuntimeConnectionStatus,
  useHostRuntimeConnectionStatuses,
} from "@/runtime/host-runtime";
import { useFetchQueries } from "@/data/query";

const REFRESH_INTERVAL_MS = 30_000;

interface WorkspaceFileSystemStatusProject {
  projectSecondaryLabel?: string | null;
  hosts: readonly {
    serverId: string;
    iconWorkingDir: string;
  }[];
}

interface WorkspaceFileSystemStatusTarget {
  serverId: string;
  cwd: string;
}

function stateFromHost(status: HostRuntimeConnectionStatus): WorkspaceFileSystemStatus["state"] {
  if (status === "online") return "online";
  if (status === "connecting") return "connecting";
  if (status === "error") return "error";
  if (status === "offline") return "offline";
  return "unknown";
}

export function aggregateWorkspaceFileSystemStatuses(
  statuses: readonly WorkspaceFileSystemStatus[],
): WorkspaceFileSystemStatus | null {
  const first = (state: WorkspaceFileSystemStatus["state"]) =>
    statuses.find((status) => status.state === state);
  return (
    first("online") ??
    first("connecting") ??
    first("error") ??
    first("offline") ??
    first("unknown") ??
    null
  );
}

export function useWorkspaceFileSystemStatus(
  project: WorkspaceFileSystemStatusProject,
): WorkspaceFileSystemStatus | null {
  const enabled = Boolean(project.projectSecondaryLabel);
  const targets = useMemo<WorkspaceFileSystemStatusTarget[]>(
    () =>
      enabled
        ? project.hosts.flatMap((host) => {
            const cwd = host.iconWorkingDir.trim();
            return cwd ? [{ serverId: host.serverId, cwd }] : [];
          })
        : [],
    [enabled, project.hosts],
  );
  const serverIds = useMemo(
    () => [...new Set(targets.map((target) => target.serverId))],
    [targets],
  );
  const hostStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const results = useFetchQueries<WorkspaceFileSystemStatus | null>(
    targets.map((target) => ({
      queryKey: ["workspace-file-system-status", target.serverId, target.cwd],
      queryFn: async () => {
        const client = getHostRuntimeStore().getSnapshot(target.serverId)?.client;
        return client ? client.getWorkspaceFileSystemStatus(target.cwd) : null;
      },
      dataShape: "value" as const,
      enabled: hostStatuses.get(target.serverId) === "online",
      retry: false,
      staleTimeMs: REFRESH_INTERVAL_MS / 2,
      refetchInterval: REFRESH_INTERVAL_MS,
      refetchIntervalInBackground: false,
    })),
  );

  return useMemo(() => {
    if (!enabled) return null;
    const statuses: WorkspaceFileSystemStatus[] = [];
    for (let index = 0; index < targets.length; index += 1) {
      const providerStatus = results[index]?.data;
      if (!providerStatus) continue;
      const hostState = stateFromHost(hostStatuses.get(targets[index]!.serverId) ?? "idle");
      statuses.push(hostState === "online" ? providerStatus : { state: hostState });
    }
    return aggregateWorkspaceFileSystemStatuses(statuses);
  }, [enabled, hostStatuses, results, targets]);
}
