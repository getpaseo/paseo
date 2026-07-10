import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import equal from "fast-deep-equal";
import { useStoreWithEqualityFn } from "zustand/traditional";
import {
  getHostRuntimeStore,
  isHostRuntimeDirectoryLoading,
  useHosts,
  type HostRuntimeSnapshot,
} from "@/runtime/host-runtime";
import {
  useSessionStore,
  type EmptyProjectDescriptor,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
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
  emptyProjects: EmptyProjectDescriptor[];
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

function selectProjectHostReplicas(
  hosts: readonly { serverId: string; label: string }[],
): (state: ReturnType<typeof useSessionStore.getState>) => ProjectHostReplica[] {
  return (state) =>
    hosts.map((host) => {
      const session = state.sessions[host.serverId];
      return {
        serverId: host.serverId,
        serverName: host.label,
        workspaces: Array.from(session?.workspaces.values() ?? []),
        emptyProjects: Array.from(session?.emptyProjects.values() ?? []),
      };
    });
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
      emptyProjects: replica.emptyProjects,
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

function useProjectHostRuntimeStates(serverIds: readonly string[]): ProjectHostRuntimeState[] {
  const runtime = getHostRuntimeStore();
  const previousStatesRef = useRef<ProjectHostRuntimeState[]>([]);
  const runtimeSnapshotTick = useSyncExternalStore(
    (onStoreChange) => runtime.subscribeAll(onStoreChange),
    () => runtime.getVersion(),
    () => runtime.getVersion(),
  );
  return useMemo(() => {
    void runtimeSnapshotTick;
    const nextStates = serverIds.map((serverId) =>
      toProjectHostRuntimeState(serverId, runtime.getSnapshot(serverId)),
    );
    if (equal(previousStatesRef.current, nextStates)) {
      return previousStatesRef.current;
    }
    previousStatesRef.current = nextStates;
    return nextStates;
  }, [runtime, runtimeSnapshotTick, serverIds]);
}

export function useProjects(): UseProjectsResult {
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const replicas = useStoreWithEqualityFn(useSessionStore, selectProjectHostReplicas(hosts), equal);
  const runtimeStates = useProjectHostRuntimeStates(serverIds);
  const derived = useMemo(
    () => deriveProjectsFromReplica({ replicas, runtimeStates }),
    [replicas, runtimeStates],
  );
  const refetch = useCallback(() => {
    runtime.refreshAllAgentDirectories({ serverIds });
  }, [runtime, serverIds]);

  return {
    ...derived,
    refetch,
  };
}
