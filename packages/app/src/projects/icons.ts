import { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { ProjectAppearance, ProjectIcon } from "@getpaseo/protocol/messages";
import { useHostFeatureMap } from "@/runtime/host-features";
import {
  getHostRuntimeStore,
  isHostRuntimeConnected,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
} from "@/runtime/host-runtime";

interface ProjectIconTarget {
  serverId: string;
  projectViewKey: string;
  projectKey: string;
  iconWorkingDir: string;
  projectAppearance?: ProjectAppearance | null;
}

function legacyIconQueryKey(serverId: string, cwd: string) {
  return ["projectIcon", serverId, "legacy", cwd] as const;
}

function iconQueryKey(serverId: string, projectId: string, revision: string) {
  return ["projectIcon", serverId, projectId, revision] as const;
}

function iconDataUri(icon: ProjectIcon | null): string | null {
  if (!icon) return null;
  return `data:${icon.mimeType};base64,${icon.data}`;
}

function useStableIconData(data: (string | null)[], signature: string): readonly (string | null)[] {
  const stableRef = useRef<{ signature: string; data: (string | null)[] } | null>(null);
  if (stableRef.current?.signature !== signature) {
    stableRef.current = { signature, data };
  }
  return stableRef.current.data;
}

export function useProjectIcon({ serverId, cwd }: { serverId: string; cwd: string }) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  const query = useQuery({
    queryKey: legacyIconQueryKey(serverId, cwd),
    queryFn: async (): Promise<ProjectIcon | null> => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const result = await client.requestProjectIcon(cwd);
      return result.icon;
    },
    enabled: Boolean(client && isConnected && cwd),
    staleTime: Infinity,
    gcTime: 1000 * 60 * 60,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  return {
    icon: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

export function useProjectIcons(input: {
  projects: readonly ProjectIconTarget[];
}): Map<string, string | null> {
  const serverIds = useMemo(
    () => [...new Set(input.projects.map((project) => project.serverId))],
    [input.projects],
  );
  const supportsAppearance = useHostFeatureMap(serverIds, "projectAppearance");
  const requests = useMemo(() => {
    const unique = new Map<string, ProjectIconTarget>();
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
          ? iconQueryKey(request.serverId, request.projectKey, revision)
          : legacyIconQueryKey(request.serverId, request.iconWorkingDir),
        queryFn: async () => {
          const client = getHostRuntimeStore().getClient(request.serverId);
          if (!client) return null;
          const result = supports
            ? await client.getProjectIcon(request.projectKey)
            : await client.requestProjectIcon(request.iconWorkingDir);
          return result.icon;
        },
        select: iconDataUri,
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
  const data = useStableIconData(
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
