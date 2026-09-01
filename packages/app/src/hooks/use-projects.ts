import { useCallback, useEffect, useMemo, useRef } from "react";
import equal from "fast-deep-equal";
import {
  acquireDirectoryDemand,
  isHostRuntimeDirectoryLoading,
  readHostRuntimeSnapshot,
  refreshHostDirectories,
  useHostRuntimeVersion,
  useHosts,
  type HostRuntimeSnapshot,
} from "@/runtime/host-runtime";
import {
  useWorkspaceDirectories,
  type WorkspaceDirectoryView,
  type ProjectDescriptor,
  type WorkspaceDescriptor,
} from "@/stores/session-store-hooks";
import { buildProjects, type ProjectHost, type ProjectSummary } from "@/utils/projects";

export interface ProjectHostError {
  serverId: string;
  serverName: string;
  message: string;
}

export interface ProjectHostReplica {
  serverId: string;
  serverName: string;
  workspaces: WorkspaceDescriptor[];
  projects: ProjectDescriptor[];
}

export interface ProjectHostRuntimeState {
  serverId: string;
  isOnline: boolean;
  isLoading: boolean;
  isFetching: boolean;
  error: string | null;
}

export interface DerivedProjectsResult {
  projects: ProjectSummary[];
  hostErrors: ProjectHostError[];
  isLoading: boolean;
  isFetching: boolean;
}

export interface UseProjectsResult {
  projects: ProjectSummary[];
  hostErrors: ProjectHostError[];
  isLoading: boolean;
  isFetching: boolean;
  refetch: () => void;
}

export interface UseProjectsOptions {
  enabled?: boolean;
}

const EMPTY_PROJECT_HOST_REPLICAS: ProjectHostReplica[] = [];
const EMPTY_PROJECT_HOST_RUNTIME_STATES: ProjectHostRuntimeState[] = [];

function toProjectHostRuntimeState(
  serverId: string,
  snapshot: HostRuntimeSnapshot | null,
): ProjectHostRuntimeState {
  const isFetching =
    snapshot?.agentDirectoryStatus === "initial_loading" ||
    snapshot?.agentDirectoryStatus === "revalidating";
  return {
    serverId,
    isOnline: snapshot?.connectionStatus === "online",
    isLoading: isHostRuntimeDirectoryLoading(snapshot),
    isFetching,
    error: snapshot?.agentDirectoryError ?? null,
  };
}

function createProjectHostReplicasSelector(
  hosts: readonly { serverId: string; label: string }[],
  enabled: boolean,
): (directories: ReadonlyMap<string, WorkspaceDirectoryView>) => ProjectHostReplica[] {
  let previousInputs: Array<{
    workspaces: WorkspaceDirectoryView["workspaces"] | undefined;
    projects: WorkspaceDirectoryView["projects"] | undefined;
  }> | null = null;
  let previousResult = EMPTY_PROJECT_HOST_REPLICAS;
  return (directories) => {
    if (!enabled) return EMPTY_PROJECT_HOST_REPLICAS;
    const inputs = hosts.map((host) => {
      const directory = directories.get(host.serverId);
      return { workspaces: directory?.workspaces, projects: directory?.projects };
    });
    const priorInputs = previousInputs;
    if (
      priorInputs &&
      inputs.every(
        (input, index) =>
          input.workspaces === priorInputs[index]?.workspaces &&
          input.projects === priorInputs[index]?.projects,
      )
    ) {
      return previousResult;
    }
    previousInputs = inputs;
    previousResult = hosts.map((host, index) => ({
      serverId: host.serverId,
      serverName: host.label,
      workspaces: Array.from(inputs[index]?.workspaces?.values() ?? []),
      projects: Array.from(inputs[index]?.projects?.values() ?? []),
    }));
    return previousResult;
  };
}

export function deriveProjectsFromReplica(input: {
  replicas: readonly ProjectHostReplica[];
  runtimeStates: readonly ProjectHostRuntimeState[];
}): DerivedProjectsResult {
  const runtimeByServerId = new Map(
    input.runtimeStates.map((state) => [state.serverId, state] as const),
  );
  const hosts: ProjectHost[] = input.replicas.map((replica) => {
    const runtimeState = runtimeByServerId.get(replica.serverId);
    return {
      serverId: replica.serverId,
      serverName: replica.serverName,
      isOnline: runtimeState?.isOnline ?? false,
      workspaces: replica.workspaces,
      projects: replica.projects,
    };
  });
  const hostErrors = input.replicas.flatMap((replica) => {
    const message = runtimeByServerId.get(replica.serverId)?.error;
    return message
      ? [
          {
            serverId: replica.serverId,
            serverName: replica.serverName,
            message,
          },
        ]
      : [];
  });

  return {
    ...buildProjects({ hosts }),
    hostErrors,
    isLoading: input.runtimeStates.some((state) => state.isLoading),
    isFetching: input.runtimeStates.some((state) => state.isFetching),
  };
}

function useProjectHostRuntimeStates(
  serverIds: readonly string[],
  enabled: boolean,
): ProjectHostRuntimeState[] {
  const previousStatesRef = useRef<ProjectHostRuntimeState[]>([]);
  const runtimeSnapshotTick = useHostRuntimeVersion();
  return useMemo(() => {
    if (!enabled) {
      previousStatesRef.current = EMPTY_PROJECT_HOST_RUNTIME_STATES;
      return EMPTY_PROJECT_HOST_RUNTIME_STATES;
    }
    void runtimeSnapshotTick;
    const nextStates = serverIds.map((serverId) =>
      toProjectHostRuntimeState(serverId, readHostRuntimeSnapshot(serverId)),
    );
    if (equal(previousStatesRef.current, nextStates)) {
      return previousStatesRef.current;
    }
    previousStatesRef.current = nextStates;
    return nextStates;
  }, [enabled, runtimeSnapshotTick, serverIds]);
}

export function useProjects(options: UseProjectsOptions = {}): UseProjectsResult {
  const enabled = options.enabled ?? true;
  const hosts = useHosts();
  const serverIds = useMemo(
    () => (enabled ? hosts.map((host) => host.serverId) : []),
    [enabled, hosts],
  );
  useEffect(() => {
    const releases = serverIds.map(acquireDirectoryDemand);
    return () => releases.forEach((release) => release());
  }, [serverIds]);
  const selectReplicas = useMemo(
    () => createProjectHostReplicasSelector(hosts, enabled),
    [enabled, hosts],
  );
  const replicas = useWorkspaceDirectories(serverIds, selectReplicas);
  const runtimeStates = useProjectHostRuntimeStates(serverIds, enabled);
  const derived = useMemo(
    () => deriveProjectsFromReplica({ replicas, runtimeStates }),
    [replicas, runtimeStates],
  );
  const refetch = useCallback(() => {
    if (!enabled) return;
    for (const serverId of serverIds) void refreshHostDirectories(serverId);
  }, [enabled, serverIds]);

  return {
    ...derived,
    refetch,
  };
}
