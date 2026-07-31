import { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { ProjectIcon } from "@getpaseo/protocol/messages";
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
  projectId: string;
  iconWorkingDir: string;
  customIconRevision?: string | null;
}

/**
 * Daemons without custom-icon support only answer the legacy cwd lookup, which
 * still serves their automatically discovered icons.
 */
export function resolveProjectIconLookup(
  target: Pick<ProjectIconTarget, "projectId" | "iconWorkingDir">,
  supportsCustomIcons: boolean,
): { kind: "project"; projectId: string } | { kind: "legacy"; cwd: string } {
  return supportsCustomIcons
    ? { kind: "project", projectId: target.projectId }
    : { kind: "legacy", cwd: target.iconWorkingDir };
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
  const supportsCustomIcons = useHostFeatureMap(serverIds, "projectCustomIcon");
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
      const revision = request.customIconRevision ?? "automatic";
      const lookup = resolveProjectIconLookup(
        request,
        supportsCustomIcons.get(request.serverId) === true,
      );
      return {
        queryKey:
          lookup.kind === "project"
            ? iconQueryKey(request.serverId, lookup.projectId, revision)
            : legacyIconQueryKey(request.serverId, lookup.cwd),
        queryFn: async () => {
          const client = getHostRuntimeStore().getClient(request.serverId);
          if (!client) return null;
          const result =
            lookup.kind === "project"
              ? await client.getProjectIcon(lookup.projectId)
              : await client.requestProjectIcon(lookup.cwd);
          return result.icon;
        },
        select: iconDataUri,
        enabled: Boolean(
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
      byTarget.set(`${request.serverId}:${request.projectId}`, data[index] ?? null);
    });

    const byProject = new Map<string, string | null>();
    for (const project of input.projects) {
      byProject.set(
        project.projectViewKey,
        byTarget.get(`${project.serverId}:${project.projectId}`) ?? null,
      );
    }
    return byProject;
  }, [data, input.projects, requests]);
}
