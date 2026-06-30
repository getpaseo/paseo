import { useMemo, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import type { ProjectSummary } from "@/utils/projects";
import {
  fetchAggregatedProjects,
  type ProjectHostError,
  type ProjectsHostInput,
} from "@/projects/aggregated-projects";

export type {
  ProjectHostError,
  ProjectsHostInput,
  ProjectsRuntime,
} from "@/projects/aggregated-projects";

export const projectsQueryKey = ["projects"] as const;

function projectsQueryRuntimeKey(hosts: readonly ProjectsHostInput[]) {
  return hosts.map((host) => host.serverId).join("|");
}

export interface UseProjectsResult {
  projects: ProjectSummary[];
  hostErrors: ProjectHostError[];
  isLoading: boolean;
  isFetching: boolean;
  refetch: () => void;
}

export function useProjects(): UseProjectsResult {
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const runtimeVersion = useSyncExternalStore(
    (onStoreChange) => runtime.subscribeAll(onStoreChange),
    () => runtime.getVersion(),
    () => runtime.getVersion(),
  );
  const hostInputs = useMemo<ProjectsHostInput[]>(
    () =>
      hosts.map((host) => ({
        serverId: host.serverId,
        serverName: host.label,
      })),
    [hosts],
  );

  const projectsQuery = useQuery({
    queryKey: [...projectsQueryKey, projectsQueryRuntimeKey(hostInputs), runtimeVersion] as const,
    queryFn: () => fetchAggregatedProjects({ hosts: hostInputs, runtime }),
    staleTime: 5_000,
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
