import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore } from "@/stores/session-store";
import { selectHostFeature } from "@/runtime/host-features";

interface ProjectRemoveHost {
  serverId: string;
}

export interface ProjectRemoveProject {
  projectKey: string;
  hosts: readonly ProjectRemoveHost[];
}

export interface ProjectRemoveTarget {
  serverId: string;
}

export type ProjectRemoveReadiness =
  | { kind: "ready"; targets: ProjectRemoveTarget[] }
  | { kind: "needs_host_update"; serverIds: string[] };

export type ProjectRemoveOutcome =
  | { kind: "removed"; serverIds: string[] }
  | { kind: "host_disconnected"; serverIds: string[] }
  | { kind: "failed"; serverIds: string[] };

type ProjectRemoveClient = Pick<DaemonClient, "removeProject">;

export function getProjectRemoveReadiness(input: {
  project: ProjectRemoveProject;
  supportsProjectRemove: (serverId: string) => boolean;
}): ProjectRemoveReadiness {
  const unsupportedServerIds: string[] = [];
  const targets: ProjectRemoveTarget[] = [];

  for (const host of input.project.hosts) {
    if (!input.supportsProjectRemove(host.serverId)) {
      unsupportedServerIds.push(host.serverId);
      continue;
    }
    targets.push({ serverId: host.serverId });
  }

  if (unsupportedServerIds.length > 0) {
    return { kind: "needs_host_update", serverIds: unsupportedServerIds };
  }

  return { kind: "ready", targets };
}

export function getCurrentProjectRemoveReadiness(
  project: ProjectRemoveProject,
): ProjectRemoveReadiness {
  const sessionState = useSessionStore.getState();
  return getProjectRemoveReadiness({
    project,
    supportsProjectRemove: (serverId) => selectHostFeature(sessionState, serverId, "projectRemove"),
  });
}

export async function removeProjectFromHosts(input: {
  projectKey: string;
  targets: readonly ProjectRemoveTarget[];
  getClient: (serverId: string) => ProjectRemoveClient | null;
}): Promise<ProjectRemoveOutcome> {
  const clients: Array<{ serverId: string; client: ProjectRemoveClient }> = [];
  const disconnectedServerIds: string[] = [];

  for (const target of input.targets) {
    const client = input.getClient(target.serverId);
    if (!client) {
      disconnectedServerIds.push(target.serverId);
      continue;
    }
    clients.push({ serverId: target.serverId, client });
  }

  if (disconnectedServerIds.length > 0) {
    return { kind: "host_disconnected", serverIds: disconnectedServerIds };
  }

  const results = await Promise.allSettled(
    clients.map(async ({ client }) => {
      await client.removeProject(input.projectKey);
    }),
  );
  const failedServerIds: string[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      const failed = clients[index];
      if (failed) {
        failedServerIds.push(failed.serverId);
      }
    }
  }

  if (failedServerIds.length > 0) {
    return { kind: "failed", serverIds: failedServerIds };
  }

  return { kind: "removed", serverIds: clients.map((entry) => entry.serverId) };
}
