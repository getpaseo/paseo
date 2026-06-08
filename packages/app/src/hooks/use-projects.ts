import { useMemo } from "react";
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
