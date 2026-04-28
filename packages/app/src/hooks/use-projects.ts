import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DaemonClient } from "@server/client/daemon-client";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import { normalizeWorkspaceDescriptor, type WorkspaceDescriptor } from "@/stores/session-store";
import { buildProjects, type ProjectHost, type ProjectSummary } from "@/utils/projects";

export const projectsQueryKey = ["projects"] as const;

export interface ProjectHostError {
  serverId: string;
  serverName: string;
  message: string;
}

export interface UseProjectsResult {
  projects: ProjectSummary[];
  hiddenUnsupportedRemoteCount: number;
  hostErrors: ProjectHostError[];
  isLoading: boolean;
  isFetching: boolean;
  refetch: () => void;
}

interface FetchAllWorkspaceDescriptorsInput {
  client: Pick<DaemonClient, "fetchWorkspaces">;
}

interface HostWorkspacesResult {
  host: ProjectHost;
  error: ProjectHostError | null;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchAllWorkspaceDescriptors(
  input: FetchAllWorkspaceDescriptorsInput,
): Promise<WorkspaceDescriptor[]> {
  const entries: WorkspaceDescriptor[] = [];
  let cursor: string | null = null;

  while (true) {
    const payload = await input.client.fetchWorkspaces({
      sort: [{ key: "name", direction: "asc" }],
      page: cursor ? { limit: 200, cursor } : { limit: 200 },
    });
    entries.push(...payload.entries.map((entry) => normalizeWorkspaceDescriptor(entry)));
    if (!payload.pageInfo.hasMore || !payload.pageInfo.nextCursor) {
      break;
    }
    cursor = payload.pageInfo.nextCursor;
  }

  return entries;
}

export function useProjects(): UseProjectsResult {
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const hostInputs = useMemo(
    () =>
      hosts.map((host) => ({
        serverId: host.serverId,
        serverName: host.label,
      })),
    [hosts],
  );

  const projectsQuery = useQuery({
    queryKey: projectsQueryKey,
    queryFn: async () => {
      const results = await Promise.all(
        hostInputs.map(async (host): Promise<HostWorkspacesResult> => {
          const snapshot = runtime.getSnapshot(host.serverId);
          const isOnline = snapshot?.connectionStatus === "online";
          const client = runtime.getClient(host.serverId);

          if (!client || !isOnline) {
            return {
              host: {
                serverId: host.serverId,
                serverName: host.serverName,
                isOnline,
                workspaces: [],
              },
              error: null,
            };
          }

          try {
            return {
              host: {
                serverId: host.serverId,
                serverName: host.serverName,
                isOnline,
                workspaces: await fetchAllWorkspaceDescriptors({ client }),
              },
              error: null,
            };
          } catch (error) {
            return {
              host: {
                serverId: host.serverId,
                serverName: host.serverName,
                isOnline,
                workspaces: [],
              },
              error: {
                serverId: host.serverId,
                serverName: host.serverName,
                message: toErrorMessage(error),
              },
            };
          }
        }),
      );

      const hostErrors = results.flatMap((result) => (result.error ? [result.error] : []));
      return {
        ...buildProjects({ hosts: results.map((result) => result.host) }),
        hostErrors,
      };
    },
  });

  return {
    projects: projectsQuery.data?.projects ?? [],
    hiddenUnsupportedRemoteCount: projectsQuery.data?.hiddenUnsupportedRemoteCount ?? 0,
    hostErrors: projectsQuery.data?.hostErrors ?? [],
    isLoading: projectsQuery.isLoading,
    isFetching: projectsQuery.isFetching,
    refetch: () => {
      void projectsQuery.refetch();
    },
  };
}
