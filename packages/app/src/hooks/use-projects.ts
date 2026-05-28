import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
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
  hostErrors: ProjectHostError[];
  isLoading: boolean;
  isFetching: boolean;
  refetch: () => void;
}

export interface ProjectsRuntimeSnapshot {
  connectionStatus: string;
}

export interface ProjectsRuntime {
  getClient(serverId: string): Pick<DaemonClient, "fetchWorkspaces"> | null;
  getSnapshot(serverId: string): ProjectsRuntimeSnapshot | null | undefined;
}

export interface ProjectsHostInput {
  serverId: string;
  serverName: string;
}

export interface FetchAggregatedProjectsInput {
  hosts: ProjectsHostInput[];
  runtime: ProjectsRuntime;
}

export interface FetchAggregatedProjectsResult {
  projects: ProjectSummary[];
  hostErrors: ProjectHostError[];
}

interface HostWorkspacesResult {
  host: ProjectHost;
  error: ProjectHostError | null;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchAllWorkspaceDescriptors(
  client: Pick<DaemonClient, "fetchWorkspaces">,
): Promise<WorkspaceDescriptor[]> {
  const entries: WorkspaceDescriptor[] = [];
  let cursor: string | null = null;

  while (true) {
    const payload = await client.fetchWorkspaces({
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

export async function fetchAggregatedProjects(
  input: FetchAggregatedProjectsInput,
): Promise<FetchAggregatedProjectsResult> {
  const results = await Promise.all(
    input.hosts.map(async (host): Promise<HostWorkspacesResult> => {
      const snapshot = input.runtime.getSnapshot(host.serverId);
      const isOnline = snapshot?.connectionStatus === "online";
      const client = input.runtime.getClient(host.serverId);

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
            workspaces: await fetchAllWorkspaceDescriptors(client),
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
}

export function useProjects(): UseProjectsResult {
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const hostInputs = useMemo<ProjectsHostInput[]>(
    () =>
      hosts.map((host) => ({
        serverId: host.serverId,
        serverName: host.label,
      })),
    [hosts],
  );

  const projectsQuery = useQuery({
    queryKey: projectsQueryKey,
    queryFn: () => fetchAggregatedProjects({ hosts: hostInputs, runtime }),
  });

  return {
    projects: projectsQuery.data?.projects ?? [],
    hostErrors: projectsQuery.data?.hostErrors ?? [],
    isLoading: projectsQuery.isLoading,
    isFetching: projectsQuery.isFetching,
    refetch: () => {
      void projectsQuery.refetch();
    },
  };
}
