import { useCallback, useMemo, useRef } from "react";
import { Alert } from "react-native";
import type { SessionContextValue } from "@/contexts/session-context";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";
import { useSessionStore } from "@/stores/session-store";
import { useSessionHeavyState } from "@/stores/session-heavy-state";

export class DaemonSessionUnavailableError extends Error {
  serverId: string;

  constructor(serverId: string) {
    super(`Host session "${serverId}" is unavailable`);
    this.name = "DaemonSessionUnavailableError";
    this.serverId = serverId;
  }
}

type UseDaemonSessionOptions = {
  suppressUnavailableAlert?: boolean;
  allowUnavailable?: boolean;
};

export function useDaemonSession(
  serverId?: string | null,
  options?: UseDaemonSessionOptions & { allowUnavailable?: false }
): SessionContextValue | null;
export function useDaemonSession(
  serverId: string | null | undefined,
  options: UseDaemonSessionOptions & { allowUnavailable: true }
): SessionContextValue | null;
export function useDaemonSession(serverId?: string | null, options?: UseDaemonSessionOptions) {
  const selectSession = useCallback(
    (state: ReturnType<typeof useSessionStore.getState>) => {
      if (!serverId) {
        return null;
      }
      return state.sessions[serverId] ?? null;
    },
    [serverId]
  );
  const baseSession = useSessionStore(selectSession);
  const heavyState = useSessionHeavyState(serverId ?? null);
  const session = useMemo(() => {
    if (!baseSession) {
      return null;
    }
    if (!serverId || !heavyState) {
      return baseSession;
    }
    return {
      ...baseSession,
      messages: heavyState.messages,
      agentStreamState: heavyState.agentStreamState,
    } as SessionContextValue;
  }, [baseSession, heavyState, serverId]);
  const { connectionStates } = useDaemonConnections();
  const alertedDaemonsRef = useRef<Set<string>>(new Set());
  const loggedDaemonsRef = useRef<Set<string>>(new Set());
  const { suppressUnavailableAlert = false, allowUnavailable = false } = options ?? {};

  if (!serverId) {
    return null;
  }

  try {
    if (!session) {
      throw new DaemonSessionUnavailableError(serverId);
    }
    return session;
  } catch (error) {
    if (error instanceof DaemonSessionUnavailableError) {
      const connection = connectionStates.get(serverId);
      const label = connection?.daemon.label ?? serverId;
      const status = connection?.status ?? "unknown";
      const lastError = connection?.lastError ? `\n${connection.lastError}` : "";
      const message = `${label} isn't connected yet (${status}). Paseo reconnects automatically and will enable actions once it's back.${lastError}`;

      if (!suppressUnavailableAlert && !alertedDaemonsRef.current.has(serverId)) {
        alertedDaemonsRef.current.add(serverId);
        Alert.alert("Host unavailable", message.trim());
      }

      if (!loggedDaemonsRef.current.has(serverId)) {
        loggedDaemonsRef.current.add(serverId);
        console.warn(`[useDaemonSession] Session unavailable for daemon "${label}" (${status}).`);
      }

      if (allowUnavailable) {
        return null;
      }
    }
    throw error;
  }
}
