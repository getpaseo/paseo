import { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { ProjectIcon } from "@getpaseo/protocol/messages";
import { useHostFeatureAvailabilityMap } from "@/runtime/host-features";
import { projectIconCache } from "@/projects/icon-cache";
import type { ProjectIconPresentation } from "@/projects/icon-cache";
import type { ProjectIconTarget } from "@/projects/icon-target";
import {
  getHostRuntimeStore,
  isHostRuntimeConnected,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
} from "@/runtime/host-runtime";

/**
 * Daemons without custom-icon support only answer the legacy cwd lookup, which
 * still serves their automatically discovered icons.
 */
export function resolveProjectIconLookup(
  target: Pick<ProjectIconTarget, "projectId" | "iconWorkingDir">,
  supportsCustomIcons: boolean | null,
): { kind: "project"; projectId: string } | { kind: "legacy"; cwd: string } | null {
  if (supportsCustomIcons === null) return null;
  return supportsCustomIcons
    ? { kind: "project", projectId: target.projectId }
    : { kind: "legacy", cwd: target.iconWorkingDir };
}

function legacyIconQueryKey(serverId: string, cwd: string) {
  return ["projectIcon", serverId, "legacy", cwd] as const;
}

function iconDataUri(icon: ProjectIcon | null): string | null {
  if (!icon) return null;
  return `data:${icon.mimeType};base64,${icon.data}`;
}

export interface ProjectIconRenderData {
  dataUri: string | null;
  emoji: string | null;
}

function renderData(presentation: ProjectIconPresentation): ProjectIconRenderData {
  return { dataUri: iconDataUri(presentation.icon), emoji: presentation.emoji };
}

function useStableIconData(
  data: ProjectIconRenderData[],
  signature: string,
): readonly ProjectIconRenderData[] {
  const stableRef = useRef<{ signature: string; data: ProjectIconRenderData[] } | null>(null);
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
}): Map<string, ProjectIconRenderData> {
  const serverIds = useMemo(
    () => [...new Set(input.projects.map((project) => project.serverId))],
    [input.projects],
  );
  const supportsCustomIcons = useHostFeatureAvailabilityMap(serverIds, "projectCustomIcon");
  const requests = useMemo(() => {
    const unique = new Map<string, ProjectIconTarget>();
    for (const project of input.projects) {
      if (!project.serverId || !project.projectId || !project.iconWorkingDir.trim()) continue;
      unique.set(`${project.serverId}:${project.projectId}`, project);
    }
    return Array.from(unique.values());
  }, [input.projects]);

  const queries = useQueries({
    queries: requests.map((request) => {
      return {
        ...projectIconCache.query(
          request,
          supportsCustomIcons.get(request.serverId) ?? null,
          () => getHostRuntimeStore().getClient(request.serverId),
          isHostRuntimeConnected(getHostRuntimeStore().getSnapshot(request.serverId)),
        ),
        select: renderData,
      };
    }),
  });

  const signature = queries
    .map((query) => `${query.data?.emoji ?? ""}\u0000${query.data?.dataUri ?? ""}`)
    .join("\u0001");
  const data = useStableIconData(
    queries.map((query) => query.data ?? { dataUri: null, emoji: null }),
    signature,
  );

  return useMemo(() => {
    const byTarget = new Map<string, ProjectIconRenderData>();
    requests.forEach((request, index) => {
      byTarget.set(
        `${request.serverId}:${request.projectId}`,
        data[index] ?? { dataUri: null, emoji: null },
      );
    });

    const byProject = new Map<string, ProjectIconRenderData>();
    for (const project of input.projects) {
      byProject.set(
        project.projectViewKey,
        byTarget.get(`${project.serverId}:${project.projectId}`) ?? {
          dataUri: null,
          emoji: null,
        },
      );
    }
    return byProject;
  }, [data, input.projects, requests]);
}
