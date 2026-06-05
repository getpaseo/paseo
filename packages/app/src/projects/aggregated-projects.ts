import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { fetchAllWorkspaceDescriptors } from "@/projects/workspace-fetching";
import { buildProjects, type ProjectHost, type ProjectSummary } from "@/utils/projects";

export interface ProjectHostError {
  serverId: string;
  serverName: string;
  message: string;
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
        const workspaces: WorkspaceDescriptor[] = await fetchAllWorkspaceDescriptors({
          client,
          sort: [{ key: "name", direction: "asc" }],
        });
        return {
          host: {
            serverId: host.serverId,
            serverName: host.serverName,
            isOnline,
            workspaces,
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
