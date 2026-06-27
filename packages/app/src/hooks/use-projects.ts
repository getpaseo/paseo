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
    // The global QueryClient pins staleTime/gcTime to Infinity and disables
    // refetchOnMount, so an invalidate fired while this screen is unmounted (the
    // usual "add a project from the sidebar" path) only marks the cache stale
    // without refetching. Without this, opening the projects settings screen
    // shows the pre-add cache until something else triggers a refetch. With
    // staleTime Infinity the cache only goes stale via an explicit invalidate,
    // so refetch-if-stale on mount picks up a freshly-added project without
    // refetching on every visit.
    refetchOnMount: true,
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
