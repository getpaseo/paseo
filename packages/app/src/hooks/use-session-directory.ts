import { useCallback, useMemo } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useSessionStore, type SessionState } from "@/stores/session-store";

export function useSessionDirectory(): Map<string, SessionState> {
  const sessions = useSessionStore((state) => state.sessions);

  return useMemo(() => {
    return new Map<string, SessionState>(Object.entries(sessions));
  }, [sessions]);
}

type SessionSelector<T> = (session: SessionState | null) => T;
type EqualityFn<T> = ((left: T, right: T) => boolean) | undefined;

export function useSessionForServer(serverId: string | null): SessionState | null;
export function useSessionForServer<T>(
  serverId: string | null,
  selector: SessionSelector<T>,
  equalityFn?: EqualityFn<T>
): T;
export function useSessionForServer<T>(
  serverId: string | null,
  selector?: SessionSelector<T>,
  equalityFn?: EqualityFn<T>
): SessionState | null | T {
  const storeSelector = useCallback(
    (state: ReturnType<typeof useSessionStore.getState>): SessionState | null | T => {
      const session = serverId ? state.sessions[serverId] ?? null : null;
      return selector ? selector(session) : session;
    },
    [selector, serverId]
  );

  return useStoreWithEqualityFn(
    useSessionStore,
    storeSelector,
    equalityFn as EqualityFn<SessionState | null | T>
  );
}
