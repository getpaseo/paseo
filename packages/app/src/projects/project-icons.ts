import { useMemo, useRef } from "react";
import { useQueries } from "@tanstack/react-query";
import { getHostRuntimeStore, isHostRuntimeConnected } from "@/runtime/host-runtime";
import { projectIconQueryKey, projectIconToDataUri } from "@/hooks/use-project-icon-query";

export interface ProjectIconRequestTarget {
  serverId?: string | null;
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
  serverId: string | null;
  projects: readonly ProjectIconRequestTarget[];
}): Map<string, string | null> {
  const projectIconRequests = useMemo(() => {
    const unique = new Map<string, { serverId: string; cwd: string }>();
    for (const project of input.projects) {
      const serverId = project.serverId || input.serverId;
      if (!serverId) {
        continue;
      }
      const cwd = project.iconWorkingDir.trim();
      if (!cwd) {
        continue;
      }
      unique.set(`${serverId}:${cwd}`, { serverId, cwd });
    }
    return Array.from(unique.values());
  }, [input.projects, input.serverId]);

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
      const serverId = project.serverId || input.serverId;
      const cwd = project.iconWorkingDir.trim();
      if (!cwd || !serverId) {
        byProject.set(project.projectKey, null);
        continue;
      }
      byProject.set(project.projectKey, iconByServerAndCwd.get(`${serverId}:${cwd}`) ?? null);
    }

    return byProject;
  }, [input.projects, input.serverId, projectIconData, projectIconRequests]);
}
