import { useCallback } from "react";
import { useSessionStore } from "@/stores/session-store";
import {
  createInitDeferred,
  getInitDeferred,
  getInitKey,
  rejectInitDeferred,
} from "@/utils/agent-initialization";

const INIT_TIMEOUT_MS = 10000;

export function useAgentInitialization(serverId: string) {
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const setInitializingAgents = useSessionStore((state) => state.setInitializingAgents);
  const setAgentStreamTail = useSessionStore((state) => state.setAgentStreamTail);
  const clearAgentStreamHead = useSessionStore((state) => state.clearAgentStreamHead);

  const ensureAgentIsInitialized = useCallback(
    (agentId: string): Promise<void> => {
      const key = getInitKey(serverId, agentId);
      const existing = getInitDeferred(key);
      if (existing) {
        return existing.promise;
      }

      const deferred = createInitDeferred(key);

      const timeoutId = setTimeout(() => {
        rejectInitDeferred(key, new Error(`Agent initialization timed out after ${INIT_TIMEOUT_MS}ms`));
      }, INIT_TIMEOUT_MS);

      setInitializingAgents(serverId, (prev) => {
        const next = new Map(prev);
        next.set(agentId, true);
        return next;
      });

      setAgentStreamTail(serverId, (prev) => {
        const next = new Map(prev);
        next.set(agentId, []);
        return next;
      });
      clearAgentStreamHead(serverId, agentId);

      if (!client) {
        clearTimeout(timeoutId);
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
          clearTimeout(timeoutId);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
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
    [clearAgentStreamHead, client, serverId, setAgentStreamTail, setInitializingAgents]
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

      setAgentStreamTail(serverId, (prev) => {
        const next = new Map(prev);
        next.set(agentId, []);
        return next;
      });
      clearAgentStreamHead(serverId, agentId);

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
    [clearAgentStreamHead, client, serverId, setAgentStreamTail, setInitializingAgents]
  );

  return { ensureAgentIsInitialized, refreshAgent };
}

