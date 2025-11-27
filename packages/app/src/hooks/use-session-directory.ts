import { useMemo } from "react";
import { useSessionStore, type SessionData } from "@/stores/session-store";

export function useSessionDirectory(): Map<string, SessionData> {
  const sessions = useSessionStore((state) => state.sessions);

  return useMemo(() => {
    return new Map<string, SessionData>(Object.entries(sessions));
  }, [sessions]);
}

export function useSessionForServer(serverId: string | null): SessionData | null {
  return useSessionStore((state) => (serverId ? state.sessions[serverId] ?? null : null));
}
