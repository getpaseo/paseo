import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
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
  type ProjectDescriptor,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import {
  buildProjectLinkPlacements,
  buildProjectLinkSuggestions,
  type LocalProjectLink,
  type ProjectLinkPlacement,
  type ProjectLinkSuggestion,
} from "@/projects/local-project-links";
import { useLocalProjectLinksStore } from "@/projects/local-project-links-store";
import { buildProjects, type ProjectHost, type ProjectSummary } from "@/utils/projects";

export interface ProjectHostError {
  serverId: string;
  serverName: string;
  message: string;
}

export interface ProjectHostReplica {
  serverId: string;
  serverName: string;
  hasHydratedWorkspaces?: boolean;
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
  projectLinkPlacements: ProjectLinkPlacement[];
  projectLinkSuggestions: ProjectLinkSuggestion[];
  hostErrors: ProjectHostError[];
  isLoading: boolean;
  isFetching: boolean;
}

export interface UseProjectsResult {
  projects: ProjectSummary[];
  /** Optional so legacy consumers can continue using the project list without local-link data. */
  projectLinkPlacements?: ProjectLinkPlacement[];
  projectLinkSuggestions?: ProjectLinkSuggestion[];
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

function selectProjectHostReplicas(
  hosts: readonly { serverId: string; label: string }[],
  enabled: boolean,
): (state: ReturnType<typeof useSessionStore.getState>) => ProjectHostReplica[] {
  if (!enabled) {
    return () => EMPTY_PROJECT_HOST_REPLICAS;
  }
  return (state) =>
    hosts.map((host) => {
      const session = state.sessions[host.serverId];
      return {
        serverId: host.serverId,
        serverName: host.label,
        hasHydratedWorkspaces: session?.hasHydratedWorkspaces ?? false,
        workspaces: Array.from(session?.workspaces.values() ?? []),
        projects: Array.from(session?.projects.values() ?? []),
      };
    });
}

export function deriveProjectsFromReplica(input: {
  replicas: readonly ProjectHostReplica[];
  runtimeStates: readonly ProjectHostRuntimeState[];
  localProjectLinks?: Iterable<LocalProjectLink>;
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

  const localProjectLinks = Array.from(input.localProjectLinks ?? []);
  const unhydratedProjectLinkServerIds = input.replicas
    .filter((replica) => replica.hasHydratedWorkspaces === false)
    .map((replica) => replica.serverId);
  const projectLinkPlacements = buildProjectLinkPlacements({ hosts });
  return {
    ...buildProjects({ hosts, localProjectLinks, unhydratedProjectLinkServerIds }),
    projectLinkPlacements,
    projectLinkSuggestions: buildProjectLinkSuggestions({
      placements: projectLinkPlacements,
      links: localProjectLinks,
    }),
    hostErrors,
    isLoading: input.runtimeStates.some((state) => state.isLoading),
    isFetching: input.runtimeStates.some((state) => state.isFetching),
  };
}

function useProjectHostRuntimeStates(
  serverIds: readonly string[],
  enabled: boolean,
): ProjectHostRuntimeState[] {
  const runtime = getHostRuntimeStore();
  const previousStatesRef = useRef<ProjectHostRuntimeState[]>([]);
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      enabled ? runtime.subscribeAll(onStoreChange) : () => undefined,
    [enabled, runtime],
  );
  const getSnapshot = useCallback(() => (enabled ? runtime.getVersion() : 0), [enabled, runtime]);
  const runtimeSnapshotTick = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => {
    if (!enabled) {
      previousStatesRef.current = EMPTY_PROJECT_HOST_RUNTIME_STATES;
      return EMPTY_PROJECT_HOST_RUNTIME_STATES;
    }
    void runtimeSnapshotTick;
    const nextStates = serverIds.map((serverId) =>
      toProjectHostRuntimeState(serverId, runtime.getSnapshot(serverId)),
    );
    if (equal(previousStatesRef.current, nextStates)) {
      return previousStatesRef.current;
    }
    previousStatesRef.current = nextStates;
    return nextStates;
  }, [enabled, runtime, runtimeSnapshotTick, serverIds]);
}

export function useProjects(options: UseProjectsOptions = {}): UseProjectsResult {
  const enabled = options.enabled ?? true;
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const serverIds = useMemo(
    () => (enabled ? hosts.map((host) => host.serverId) : []),
    [enabled, hosts],
  );
  useEffect(() => {
    const releases = serverIds.map((serverId) => runtime.acquireDirectoryDemand(serverId));
    return () => releases.forEach((release) => release());
  }, [runtime, serverIds]);
  const replicaSelector = useMemo(
    () => selectProjectHostReplicas(hosts, enabled),
    [enabled, hosts],
  );
  const replicas = useStoreWithEqualityFn(useSessionStore, replicaSelector, equal);
  const runtimeStates = useProjectHostRuntimeStates(serverIds, enabled);
  const localProjectLinks = useLocalProjectLinksStore((state) => state.links);
  const derived = useMemo(
    () => deriveProjectsFromReplica({ replicas, runtimeStates, localProjectLinks }),
    [localProjectLinks, replicas, runtimeStates],
  );
  const refetch = useCallback(() => {
    if (!enabled) return;
    for (const serverId of serverIds) void runtime.refreshDirectories(serverId);
  }, [enabled, runtime, serverIds]);

  return {
    ...derived,
    refetch,
  };
}
