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
import { deriveInitialTimelineRequest } from "@/contexts/session-timeline-bootstrap-policy";
import { isWeb } from "@/constants/platform";

const INIT_TIMEOUT_MS = 5 * 60_000;
const NATIVE_INITIAL_TIMELINE_LIMIT = 200;
const UNBOUNDED_TIMELINE_LIMIT = 0;

function resolveInitialTimelineLimit(): number {
  return isWeb ? UNBOUNDED_TIMELINE_LIMIT : NATIVE_INITIAL_TIMELINE_LIMIT;
}

export const __private__ = {
  deriveInitialTimelineRequest,
  resolveInitialTimelineLimit,
};

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

      const session = useSessionStore.getState().sessions[serverId];
      const cursor = session?.agentTimelineCursor.get(agentId);
      const initialTimelineLimit = resolveInitialTimelineLimit();
      const hasAuthoritativeHistory =
        session?.agentAuthoritativeHistoryApplied.get(agentId) === true;
      const timelineRequest = deriveInitialTimelineRequest({
        cursor: cursor ? { epoch: cursor.epoch, seq: cursor.endSeq } : null,
        hasAuthoritativeHistory,
        initialTimelineLimit,
      });
      const initRequestDirection = timelineRequest.direction === "after" ? "after" : "tail";

      const deferred = createInitDeferred(key, initRequestDirection);
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
        const initialTimelineLimit = resolveInitialTimelineLimit();
        await client.fetchAgentTimeline(agentId, {
          direction: "tail",
          limit: initialTimelineLimit,
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
