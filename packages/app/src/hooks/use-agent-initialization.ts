import { useCallback } from "react";
import { useSessionStore } from "@/stores/session-store";
import type { DaemonClient } from "@server/client/daemon-client";
import {
  attachInitTimeout,
  createInitDeferred,
  getInitDeferred,
  getInitKey,
  rejectInitDeferred,
} from "@/utils/agent-initialization";
import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";

const INIT_TIMEOUT_MS = 5 * 60_000;

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
    [serverId, setInitializingAgents],
  );

  const ensureAgentIsInitialized = useCallback(
    (agentId: string): Promise<void> => {
      const key = getInitKey(serverId, agentId);
      const existing = getInitDeferred(key);
      if (existing) {
        return existing.promise;
      }

      const timelineRequest = {
        direction: "tail" as const,
        limit: TIMELINE_FETCH_PAGE_SIZE,
        projection: "canonical" as const,
      };

      const deferred = createInitDeferred(key, "tail");
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
    },
    [client, serverId, setAgentInitializing],
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
          limit: TIMELINE_FETCH_PAGE_SIZE,
          projection: "canonical",
        });
      } catch (error) {
        setAgentInitializing(agentId, false);
        throw error;
      }
    },
    [client, setAgentInitializing],
  );

  return { ensureAgentIsInitialized, refreshAgent };
}
