import { useCallback, useMemo } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore } from "@/stores/session-store";
import {
  attachInitTimeout,
  createInitDeferred,
  getInitDeferred,
  getInitKey,
  rejectInitDeferred,
} from "@/utils/agent-initialization";
import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";

export const INIT_TIMEOUT_MS = 30_000;

export type SetAgentInitializing = (agentId: string, initializing: boolean) => void;

export interface EnsureAgentIsInitializedInput {
  serverId: string;
  agentId: string;
  client: Pick<DaemonClient, "fetchAgentTimeline"> | null;
  setAgentInitializing: SetAgentInitializing;
}

export function ensureAgentIsInitialized(input: EnsureAgentIsInitializedInput): Promise<void> {
  const { serverId, agentId, client, setAgentInitializing } = input;
  const key = getInitKey(serverId, agentId);
  const existing = getInitDeferred(key);
  if (existing) {
    return existing.promise;
  }

  const session = useSessionStore.getState().sessions[serverId];
  const cursor = session?.agentTimelineCursor.get(agentId);
  const hasAuthoritativeHistory = session?.agentAuthoritativeHistoryApplied.get(agentId) === true;
  const timelineRequest =
    hasAuthoritativeHistory && cursor
      ? {
          direction: "after" as const,
          cursor: { epoch: cursor.epoch, seq: cursor.endSeq },
          limit: TIMELINE_FETCH_PAGE_SIZE,
          projection: "canonical" as const,
        }
      : {
          direction: "tail" as const,
          limit: TIMELINE_FETCH_PAGE_SIZE,
          projection: "canonical" as const,
        };

  const deferred = createInitDeferred(key, timelineRequest.direction);
  const timeoutId = setTimeout(() => {
    setAgentInitializing(agentId, false);
    rejectInitDeferred(
      key,
      new Error(`History sync timed out after ${Math.round(INIT_TIMEOUT_MS / 1000)}s`),
    );
  }, INIT_TIMEOUT_MS);
  attachInitTimeout(key, timeoutId);

  setAgentInitializing(agentId, true);

  if (!client) {
    setAgentInitializing(agentId, false);
    rejectInitDeferred(key, new Error("Host is not connected"));
    return deferred.promise;
  }

  client.fetchAgentTimeline(agentId, timelineRequest).catch((error) => {
    setAgentInitializing(agentId, false);
    rejectInitDeferred(key, error instanceof Error ? error : new Error(String(error)));
  });

  return deferred.promise;
}

export interface RefreshAgentInput {
  agentId: string;
  client: Pick<DaemonClient, "refreshAgent" | "fetchAgentTimeline"> | null;
  setAgentInitializing: SetAgentInitializing;
}

export async function refreshAgent(input: RefreshAgentInput): Promise<void> {
  const { agentId, client, setAgentInitializing } = input;
  if (!client) {
    throw new Error("Host is not connected");
  }
  setAgentInitializing(agentId, true);

  try {
    await client.refreshAgent(agentId);
    await client.fetchAgentTimeline(agentId, {
      direction: "tail",
      limit: TIMELINE_FETCH_PAGE_SIZE,
      projection: "canonical",
    });
  } catch (error) {
    setAgentInitializing(agentId, false);
    throw error;
  }
}

export function createSetAgentInitializing(
  serverId: string,
  setInitializingAgents: ReturnType<typeof useSessionStore.getState>["setInitializingAgents"],
): SetAgentInitializing {
  return (agentId, initializing) => {
    setInitializingAgents(serverId, (prev) => {
      if (prev.get(agentId) === initializing) {
        return prev;
      }
      const next = new Map(prev);
      next.set(agentId, initializing);
      return next;
    });
  };
}

export function useAgentInitialization({
  serverId,
  client,
}: {
  serverId: string;
  client: DaemonClient | null;
}) {
  const setInitializingAgents = useSessionStore((state) => state.setInitializingAgents);
  const setAgentInitializing = useMemo(
    () => createSetAgentInitializing(serverId, setInitializingAgents),
    [serverId, setInitializingAgents],
  );

  const ensureAgentIsInitializedCallback = useCallback(
    (agentId: string): Promise<void> =>
      ensureAgentIsInitialized({ serverId, agentId, client, setAgentInitializing }),
    [client, serverId, setAgentInitializing],
  );

  const refreshAgentCallback = useCallback(
    (agentId: string): Promise<void> => refreshAgent({ agentId, client, setAgentInitializing }),
    [client, setAgentInitializing],
  );

  return {
    ensureAgentIsInitialized: ensureAgentIsInitializedCallback,
    refreshAgent: refreshAgentCallback,
  };
}
