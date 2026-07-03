import { useMemo, useRef } from "react";
import { useQueries } from "@tanstack/react-query";
import { getHostRuntimeStore, isHostRuntimeConnected } from "@/runtime/host-runtime";
import { projectIconQueryKey, projectIconToDataUri } from "@/hooks/use-project-icon-query";

export interface ProjectIconRequestTarget {
  serverId: string;
  projectKey: string;
  iconWorkingDir: string;
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

export function useProjectIconDataByProjectKey(input: {
  projects: readonly ProjectIconRequestTarget[];
}): Map<string, string | null> {
  const projectIconRequests = useMemo(() => {
    const unique = new Map<string, { serverId: string; cwd: string }>();
    for (const project of input.projects) {
      const cwd = project.iconWorkingDir.trim();
      if (!cwd) {
        continue;
      }
      unique.set(`${project.serverId}:${cwd}`, { serverId: project.serverId, cwd });
    }
    return Array.from(unique.values());
  }, [input.projects]);

  const projectIconQueries = useQueries({
    queries: projectIconRequests.map((request) => ({
      queryKey: projectIconQueryKey(request.serverId, request.cwd),
      queryFn: async () => {
        const client = getHostRuntimeStore().getClient(request.serverId);
        if (!client) {
          return null;
        }
        const result = await client.requestProjectIcon(request.cwd);
        return result.icon;
      },
      select: projectIconToDataUri,
      enabled: Boolean(
        getHostRuntimeStore().getClient(request.serverId) &&
        isHostRuntimeConnected(getHostRuntimeStore().getSnapshot(request.serverId)) &&
        request.cwd,
      ),
      staleTime: Infinity,
      gcTime: 1000 * 60 * 60,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    })),
  });

  const projectIconSignature = projectIconQueries.map((query) => query.data ?? "").join("\u0000");
  const projectIconData = useStableProjectIconData(
    projectIconQueries.map((query) => query.data ?? null),
    projectIconSignature,
  );

  return useMemo(() => {
    const iconByServerAndCwd = new Map<string, string | null>();
    for (let index = 0; index < projectIconRequests.length; index += 1) {
      const request = projectIconRequests[index];
      if (!request) {
        continue;
      }
      iconByServerAndCwd.set(`${request.serverId}:${request.cwd}`, projectIconData[index] ?? null);
    }

    const byProject = new Map<string, string | null>();
    for (const project of input.projects) {
      const cwd = project.iconWorkingDir.trim();
      if (!cwd) {
        byProject.set(project.projectKey, null);
        continue;
      }
      byProject.set(
        project.projectKey,
        iconByServerAndCwd.get(`${project.serverId}:${cwd}`) ?? null,
      );
    }

    return byProject;
  }, [input.projects, projectIconData, projectIconRequests]);
}
