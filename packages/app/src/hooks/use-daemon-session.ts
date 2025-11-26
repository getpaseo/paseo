import { useRef } from "react";
import { Alert } from "react-native";
import type { SessionContextValue } from "@/contexts/session-context";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";
import { useSessionDirectory } from "./use-session-directory";

export class DaemonSessionUnavailableError extends Error {
  serverId: string;

  constructor(serverId: string) {
    super(`Host session "${serverId}" is unavailable`);
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
  const sessionDirectory = useSessionDirectory();
  const { connectionStates } = useDaemonConnections();
  const alertedDaemonsRef = useRef<Set<string>>(new Set());
  const loggedDaemonsRef = useRef<Set<string>>(new Set());
  const { suppressUnavailableAlert = false, allowUnavailable = false } = options ?? {};

  if (!serverId) {
    return null;
  }

  try {
    return getSessionForServer(serverId, sessionDirectory);
  } catch (error) {
    if (error instanceof DaemonSessionUnavailableError) {
      const connection = connectionStates.get(serverId);
      const label = connection?.daemon.label ?? serverId;
      const status = connection?.status ?? "unknown";
      const lastError = connection?.lastError ? `\n${connection.lastError}` : "";
      const message = `${label} isn't connected yet (${status}). Switch to it and wait for Paseo to reconnect automatically.${lastError}`;

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
