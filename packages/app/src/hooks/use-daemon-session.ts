import { useRef } from "react";
import { Alert } from "react-native";
import type { SessionContextValue } from "@/contexts/session-context";
import { useSession } from "@/contexts/session-context";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";
import { useSessionDirectory } from "./use-session-directory";

export class DaemonSessionUnavailableError extends Error {
  serverId: string;

  constructor(serverId: string) {
    super(`Daemon session "${serverId}" is unavailable`);
    this.name = "DaemonSessionUnavailableError";
    this.serverId = serverId;
  }
}

export function getSessionForServer(
  serverId: string,
  directory: Map<string, SessionContextValue | null>
): SessionContextValue {
  const session = directory.get(serverId) ?? null;
  if (!session) {
    throw new DaemonSessionUnavailableError(serverId);
  }
  return session;
}

type UseDaemonSessionOptions = {
  suppressUnavailableAlert?: boolean;
};

export function useDaemonSession(serverId?: string, options?: UseDaemonSessionOptions) {
  const activeSession = useSession();
  const sessionDirectory = useSessionDirectory();
  const { connectionStates } = useDaemonConnections();
  const alertedDaemonsRef = useRef<Set<string>>(new Set());
  const loggedDaemonsRef = useRef<Set<string>>(new Set());
  const { suppressUnavailableAlert = false } = options ?? {};

  const targetServerId = serverId ?? activeSession.serverId;
  const isActiveSession = targetServerId === activeSession.serverId;

  if (isActiveSession || !targetServerId) {
    return activeSession;
  }

  try {
    return getSessionForServer(targetServerId, sessionDirectory);
  } catch (error) {
    if (error instanceof DaemonSessionUnavailableError) {
      const connection = connectionStates.get(targetServerId);
      const label = connection?.daemon.label ?? targetServerId;
      const status = connection?.status ?? "unknown";
      const lastError = connection?.lastError ? `\n${connection.lastError}` : "";
      const message = `${label} isn't connected yet (${status}). Switch to it or enable auto-connect so Paseo can reach it.${lastError}`;

      if (!suppressUnavailableAlert && !alertedDaemonsRef.current.has(targetServerId)) {
        alertedDaemonsRef.current.add(targetServerId);
        Alert.alert("Daemon unavailable", message.trim());
      }

      if (!loggedDaemonsRef.current.has(targetServerId)) {
        loggedDaemonsRef.current.add(targetServerId);
        console.warn(`[useDaemonSession] Session unavailable for daemon "${label}" (${status}).`);
      }
    }
    throw error;
  }
}
