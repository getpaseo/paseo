import { useCallback } from "react";
import { useSessionStore } from "@/stores/session-store";
import {
  attachInitTimeout,
  createInitDeferred,
  getInitDeferred,
  getInitKey,
  rejectInitDeferred,
} from "@/utils/agent-initialization";

const INIT_TIMEOUT_MS = 5 * 60_000;

export function useAgentInitialization(serverId: string) {
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const setInitializingAgents = useSessionStore((state) => state.setInitializingAgents);

  const ensureAgentIsInitialized = useCallback(
    (agentId: string): Promise<void> => {
      const key = getInitKey(serverId, agentId);
      const existing = getInitDeferred(key);
      if (existing) {
        return existing.promise;
      }

      const deferred = createInitDeferred(key);
      const timeoutId = setTimeout(() => {
        setInitializingAgents(serverId, (prev) => {
          if (prev.get(agentId) !== true) {
            return prev;
          }
          const next = new Map(prev);
          next.set(agentId, false);
          return next;
        });
        rejectInitDeferred(
          key,
          new Error(
            `History sync timed out after ${Math.round(INIT_TIMEOUT_MS / 1000)}s`
          )
        );
      }, INIT_TIMEOUT_MS);
      attachInitTimeout(key, timeoutId);

      setInitializingAgents(serverId, (prev) => {
        const next = new Map(prev);
        next.set(agentId, true);
        return next;
      });

      if (!client) {
        setInitializingAgents(serverId, (prev) => {
          const next = new Map(prev);
          next.set(agentId, false);
          return next;
        });
        rejectInitDeferred(key, new Error("Host is not connected"));
        return deferred.promise;
      }

      client
        .initializeAgent(agentId)
        .then(() => {
          // No-op: the actual "timeline hydrated" signal is the `agent_stream_snapshot`
          // message, handled in SessionContext.
        })
        .catch((error) => {
          setInitializingAgents(serverId, (prev) => {
            const next = new Map(prev);
            next.set(agentId, false);
            return next;
          });
          rejectInitDeferred(
            key,
            error instanceof Error ? error : new Error(String(error))
          );
        });

      return deferred.promise;
    },
    [client, serverId, setInitializingAgents]
  );

  const refreshAgent = useCallback(
    async (agentId: string) => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      setInitializingAgents(serverId, (prev) => {
        const next = new Map(prev);
        next.set(agentId, true);
        return next;
      });

      try {
        await client.refreshAgent(agentId);
      } catch (error) {
        setInitializingAgents(serverId, (prev) => {
          const next = new Map(prev);
          next.set(agentId, false);
          return next;
        });
        throw error;
      }
    },
    [client, serverId, setInitializingAgents]
  );

  return { ensureAgentIsInitialized, refreshAgent };
}
