import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { selectHostFeature } from "@/runtime/host-features";
import { getHostRuntimeStore, type HostRuntimeConnectionStatus } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { compareGroupNames, normalizeProjectGroupName, projectGroupKey } from "./key";

export { compareGroupNames, normalizeProjectGroupName, projectGroupKey } from "./key";

/**
 * A project group is a name each member project carries on its host, next to its custom name.
 * There is no catalog: a group exists while a project names it and is gone when the last member
 * leaves. Renaming or dissolving a group is therefore a write per member project, per host.
 *
 * Mutations follow `projects/project-remove.ts`: readiness first (every host must advertise the
 * feature), refuse to start while any host is disconnected, then fan out and report which hosts
 * failed. Starting a write while a sibling host is offline is what would leave two hosts
 * disagreeing about one project, with the sidebar showing whichever host it read first.
 */

export interface ProjectGroupHostTarget {
  serverId: string;
  projectId: string;
}

export interface ProjectGroupProject {
  hosts: readonly ProjectGroupHostTarget[];
}

export type ProjectGroupReadiness =
  | { kind: "ready"; targets: ProjectGroupHostTarget[] }
  | { kind: "needs_host_update"; serverIds: string[] };

export type ProjectGroupOutcome =
  | { kind: "applied"; serverIds: string[] }
  | { kind: "needs_host_update"; serverIds: string[] }
  | { kind: "host_disconnected"; serverIds: string[] }
  | { kind: "failed"; serverIds: string[] };

export interface ProjectGroupOption {
  key: string;
  name: string;
}

type ProjectGroupClient = Pick<DaemonClient, "setProjectGroup">;

export function getProjectGroupReadiness(input: {
  project: ProjectGroupProject;
  supportsProjectGroups: (serverId: string) => boolean;
}): ProjectGroupReadiness {
  const unsupportedServerIds: string[] = [];
  const targets: ProjectGroupHostTarget[] = [];

  for (const host of input.project.hosts) {
    if (!input.supportsProjectGroups(host.serverId)) {
      unsupportedServerIds.push(host.serverId);
      continue;
    }
    targets.push({ serverId: host.serverId, projectId: host.projectId });
  }

  if (unsupportedServerIds.length > 0) {
    return { kind: "needs_host_update", serverIds: unsupportedServerIds };
  }
  return { kind: "ready", targets };
}

export async function setProjectGroupOnHosts(input: {
  targets: readonly ProjectGroupHostTarget[];
  group: string | null;
  getClient: (serverId: string) => ProjectGroupClient | null;
}): Promise<ProjectGroupOutcome> {
  const clients: Array<{ serverId: string; projectId: string; client: ProjectGroupClient }> = [];
  const disconnectedServerIds: string[] = [];

  for (const target of input.targets) {
    const client = input.getClient(target.serverId);
    if (!client) {
      disconnectedServerIds.push(target.serverId);
      continue;
    }
    clients.push({ serverId: target.serverId, projectId: target.projectId, client });
  }

  if (disconnectedServerIds.length > 0) {
    return { kind: "host_disconnected", serverIds: disconnectedServerIds };
  }

  const results = await Promise.all(
    clients.map(async ({ client, projectId, serverId }) => {
      try {
        await client.setProjectGroup(projectId, input.group);
        return { serverId, ok: true as const };
      } catch {
        return { serverId, ok: false as const };
      }
    }),
  );
  const failedServerIds = results.filter((result) => !result.ok).map((result) => result.serverId);

  if (failedServerIds.length > 0) {
    return { kind: "failed", serverIds: failedServerIds };
  }
  return { kind: "applied", serverIds: clients.map((entry) => entry.serverId) };
}

/** Sets one project's group on every host it lives on, reading feature support and clients live. */
export function setProjectGroup(input: {
  project: ProjectGroupProject;
  group: string | null;
}): Promise<ProjectGroupOutcome> {
  return setProjectGroupOnProjects({ projects: [input.project], group: input.group });
}

/**
 * Applies one group value to several projects, or to none of them.
 *
 * Every host of every member is checked for support and a live connection before the first
 * write goes out, so a rename cannot land on half a group because one member's host was
 * offline. A write that fails after that point is reported per host; the group then shows as
 * two until the rename is applied again.
 */
export async function setProjectGroupOnProjects(input: {
  projects: readonly ProjectGroupProject[];
  group: string | null;
}): Promise<ProjectGroupOutcome> {
  const sessionState = useSessionStore.getState();
  const runtimeStore = getHostRuntimeStore();
  const unsupported = new Set<string>();
  const targets: ProjectGroupHostTarget[] = [];
  for (const project of input.projects) {
    const readiness = getProjectGroupReadiness({
      project,
      supportsProjectGroups: (serverId) =>
        selectHostFeature(sessionState, serverId, "projectGroups"),
    });
    if (readiness.kind === "needs_host_update") {
      for (const serverId of readiness.serverIds) unsupported.add(serverId);
      continue;
    }
    targets.push(...readiness.targets);
  }
  if (unsupported.size > 0) {
    return { kind: "needs_host_update", serverIds: Array.from(unsupported) };
  }
  return setProjectGroupOnHosts({
    targets,
    group: normalizeProjectGroupName(input.group),
    getClient: (serverId) => connectedProjectGroupClient(runtimeStore.getSnapshot(serverId)),
  });
}

/**
 * The host's client only while the host is online. A runtime keeps its client object through an
 * offline or reconnecting spell, so "has a client" is not "can take a write"; treating it as one
 * lets the online hosts of a project accept a group the offline host then never gets.
 */
export function connectedProjectGroupClient(
  snapshot: {
    client: ProjectGroupClient | null;
    connectionStatus: HostRuntimeConnectionStatus;
  } | null,
): ProjectGroupClient | null {
  if (!snapshot || snapshot.connectionStatus !== "online") return null;
  return snapshot.client;
}

/**
 * Every group name any connected host knows, merged by key and sorted for a picker.
 *
 * Read from the session store's project maps rather than the sidebar model so the picker works
 * wherever a project menu renders, filtered sidebar or not.
 */
export function useKnownProjectGroups(): readonly ProjectGroupOption[] {
  // The session store is hot, so the selector only collects map references (stable while a
  // host's project list is unchanged) and the walk happens in the memo below.
  const projectMaps = useSessionStore(
    useShallow((state) => Object.values(state.sessions).map((session) => session.projects)),
  );
  return useMemo(() => collectProjectGroups(projectMaps), [projectMaps]);
}

export function collectProjectGroups(
  projectMaps: readonly ReadonlyMap<string, { projectGroup: string | null }>[],
): ProjectGroupOption[] {
  const byKey = new Map<string, string>();
  for (const projects of projectMaps) {
    for (const project of projects.values()) {
      const name = normalizeProjectGroupName(project.projectGroup);
      if (!name) continue;
      const key = projectGroupKey(name);
      if (!byKey.has(key)) byKey.set(key, name);
    }
  }
  return Array.from(byKey, ([key, name]) => ({ key, name })).sort((left, right) =>
    compareGroupNames(left.name, right.name),
  );
}
