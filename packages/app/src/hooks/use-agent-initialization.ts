import { useCallback } from "react";
import { useSessionStore } from "@/stores/session-store";
import type {
  DaemonClient,
  FetchAgentTimelineOptions,
} from "@server/client/daemon-client";
import {
  attachInitTimeout,
  createInitDeferred,
  getInitDeferred,
  getInitKey,
  rejectInitDeferred,
} from "@/utils/agent-initialization";

const INIT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_INITIAL_TIMELINE_LIMIT = 200;

type TimelineCursorState = {
  epoch: string;
  endSeq: number;
};

function buildInitialTimelineRequest(
  cursor: TimelineCursorState | undefined
): FetchAgentTimelineOptions {
  if (!cursor) {
    return {
      direction: "tail",
      limit: DEFAULT_INITIAL_TIMELINE_LIMIT,
      projection: "projected",
    };
  }

  return {
    direction: "after",
    cursor: { epoch: cursor.epoch, seq: cursor.endSeq },
    // Catch up all missing canonical rows by default.
    limit: 0,
    projection: "projected",
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
  const setAgentInitializing = useCallback(
    (agentId: string, initializing: boolean) => {
      setInitializingAgents(serverId, (prev) => {
        if (prev.get(agentId) === initializing) {
          return prev;
        }
        const next = new Map(prev);
        next.set(agentId, initializing);
        return next;
      });
    },
    [serverId, setInitializingAgents]
  );

  const ensureAgentIsInitialized = useCallback(
    (agentId: string): Promise<void> => {
      const key = getInitKey(serverId, agentId);
      const existing = getInitDeferred(key);
      if (existing) {
        return existing.promise;
      }

      const deferred = createInitDeferred(key);
      const timeoutId = setTimeout(() => {
        setAgentInitializing(agentId, false);
        rejectInitDeferred(
          key,
          new Error(
            `History sync timed out after ${Math.round(INIT_TIMEOUT_MS / 1000)}s`
          )
        );
      }, INIT_TIMEOUT_MS);
      attachInitTimeout(key, timeoutId);

      setAgentInitializing(agentId, true);

      if (!client) {
        setAgentInitializing(agentId, false);
        rejectInitDeferred(key, new Error("Host is not connected"));
        return deferred.promise;
      }

      const session = useSessionStore.getState().sessions[serverId];
      const cursor = session?.agentTimelineCursor.get(agentId);
      const timelineRequest = buildInitialTimelineRequest(cursor);

      client
        .fetchAgentTimeline(agentId, timelineRequest)
        .then(() => {
          // No-op: hydration completion is handled by SessionContext
          // when it processes fetch_agent_timeline_response.
        })
        .catch((error) => {
          setAgentInitializing(agentId, false);
          rejectInitDeferred(
            key,
            error instanceof Error ? error : new Error(String(error))
          );
        });

      return deferred.promise;
    },
    [client, serverId, setAgentInitializing]
  );

  const refreshAgent = useCallback(
    async (agentId: string) => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      setAgentInitializing(agentId, true);

      try {
        await client.refreshAgent(agentId);
        await client.fetchAgentTimeline(agentId, {
          direction: "tail",
          limit: DEFAULT_INITIAL_TIMELINE_LIMIT,
          projection: "projected",
        });
      } catch (error) {
        setAgentInitializing(agentId, false);
        throw error;
      }
    },
    [client, setAgentInitializing]
  );

  return { ensureAgentIsInitialized, refreshAgent };
}
