import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { selectHostFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";

interface ProjectPinHost {
  serverId: string;
}

export interface ProjectPinProject {
  projectKey: string;
  hosts: readonly ProjectPinHost[];
}

export interface ProjectPinTarget {
  serverId: string;
}

export type ProjectPinReadiness =
  | { kind: "ready"; targets: ProjectPinTarget[] }
  | { kind: "needs_host_update"; serverIds: string[] };

export type ProjectPinOutcome =
  | { kind: "applied"; serverIds: string[] }
  | { kind: "host_disconnected"; serverIds: string[] }
  | { kind: "failed"; serverIds: string[] };

type ProjectPinClient = Pick<DaemonClient, "setProjectPinned">;

export function getProjectPinReadiness(input: {
  project: ProjectPinProject;
  supportsProjectPinning: (serverId: string) => boolean;
}): ProjectPinReadiness {
  const unsupportedServerIds: string[] = [];
  const targets: ProjectPinTarget[] = [];

  for (const host of input.project.hosts) {
    if (!input.supportsProjectPinning(host.serverId)) {
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

export function getCurrentProjectPinReadiness(project: ProjectPinProject): ProjectPinReadiness {
  const sessionState = useSessionStore.getState();
  return getProjectPinReadiness({
    project,
    supportsProjectPinning: (serverId) =>
      selectHostFeature(sessionState, serverId, "workspacePinning"),
  });
}

export async function setProjectPinnedOnHosts(input: {
  projectKey: string;
  pinned: boolean;
  targets: readonly ProjectPinTarget[];
  getClient: (serverId: string) => ProjectPinClient | null;
}): Promise<ProjectPinOutcome> {
  const clients: Array<{ serverId: string; client: ProjectPinClient }> = [];
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
      await client.setProjectPinned(input.projectKey, input.pinned);
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

  return { kind: "applied", serverIds: clients.map((entry) => entry.serverId) };
}
