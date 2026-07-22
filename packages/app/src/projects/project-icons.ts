import { useMemo, useRef } from "react";
import { useQueries } from "@tanstack/react-query";
import type { ProjectAppearance } from "@getpaseo/protocol/messages";
import { getHostRuntimeStore, isHostRuntimeConnected } from "@/runtime/host-runtime";
import { useHostFeatureMap } from "@/runtime/host-features";
import {
  projectIconQueryKey,
  projectIconToDataUri,
  resolvedProjectIconQueryKey,
} from "@/hooks/use-project-icon-query";

export interface ProjectIconRequestTarget {
  serverId: string;
  projectViewKey: string;
  projectKey: string;
  iconWorkingDir: string;
  projectAppearance?: ProjectAppearance | null;
}

function useStableProjectIconData(
  data: (string | null)[],
  signature: string,
): readonly (string | null)[] {
  const stableRef = useRef<{ signature: string; data: (string | null)[] } | null>(null);
  if (stableRef.current?.signature !== signature) {
    stableRef.current = { signature, data };
  }
  return stableRef.current.data;
}

export function useProjectIconDataByProjectViewKey(input: {
  projects: readonly ProjectIconRequestTarget[];
}): Map<string, string | null> {
  const serverIds = useMemo(
    () => [...new Set(input.projects.map((project) => project.serverId))],
    [input.projects],
  );
  const supportsAppearance = useHostFeatureMap(serverIds, "projectAppearance");
  const requests = useMemo(() => {
    const unique = new Map<string, ProjectIconRequestTarget>();
    for (const project of input.projects) {
      if (!project.serverId || !project.projectKey || !project.iconWorkingDir.trim()) continue;
      unique.set(`${project.serverId}:${project.projectKey}`, project);
    }
    return Array.from(unique.values());
  }, [input.projects]);

  const queries = useQueries({
    queries: requests.map((request) => {
      const supports = supportsAppearance.get(request.serverId) === true;
      const revision = request.projectAppearance?.revision ?? "automatic";
      return {
        queryKey: supports
          ? resolvedProjectIconQueryKey(request.serverId, request.projectKey, revision)
          : projectIconQueryKey(request.serverId, request.iconWorkingDir),
        queryFn: async () => {
          const client = getHostRuntimeStore().getClient(request.serverId);
          if (!client) return null;
          const result = supports
            ? await client.getProjectIcon(request.projectKey)
            : await client.requestProjectIcon(request.iconWorkingDir);
          return result.icon;
        },
        select: projectIconToDataUri,
        enabled: Boolean(
          request.projectAppearance?.icon.type !== "custom" &&
          getHostRuntimeStore().getClient(request.serverId) &&
          isHostRuntimeConnected(getHostRuntimeStore().getSnapshot(request.serverId)),
        ),
        staleTime: Infinity,
        gcTime: 1000 * 60 * 60,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      };
    }),
  });

  const signature = queries.map((query) => query.data ?? "").join("\u0000");
  const data = useStableProjectIconData(
    queries.map((query) => query.data ?? null),
    signature,
  );

  return useMemo(() => {
    const byTarget = new Map<string, string | null>();
    requests.forEach((request, index) => {
      byTarget.set(`${request.serverId}:${request.projectKey}`, data[index] ?? null);
    });

    const byProject = new Map<string, string | null>();
    for (const project of input.projects) {
      byProject.set(
        project.projectViewKey,
        byTarget.get(`${project.serverId}:${project.projectKey}`) ?? null,
      );
    }
    return byProject;
  }, [data, input.projects, requests]);
}
