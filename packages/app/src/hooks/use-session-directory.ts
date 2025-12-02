import { useCallback, useMemo } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useSessionStore, type SessionData } from "@/stores/session-store";
import { useSessionHeavyDirectory } from "@/stores/session-heavy-state";

export function useSessionDirectory(): Map<string, SessionData> {
  const sessions = useSessionStore((state) => state.sessions);
  const heavyDirectory = useSessionHeavyDirectory();

  return useMemo(() => {
    const merged = new Map<string, SessionData>();
    for (const [serverId, session] of Object.entries(sessions)) {
      const heavy = heavyDirectory.get(serverId);
      if (heavy) {
        merged.set(serverId, {
          ...session,
          messages: heavy.messages,
          agentStreamState: heavy.agentStreamState,
        });
      } else {
        merged.set(serverId, session);
      }
    }
    return merged;
  }, [heavyDirectory, sessions]);
}

type SessionSelector<T> = (session: SessionData | null) => T;
type EqualityFn<T> = ((left: T, right: T) => boolean) | undefined;

export function useSessionForServer(serverId: string | null): SessionData | null;
export function useSessionForServer<T>(
  serverId: string | null,
  selector: SessionSelector<T>,
  equalityFn?: EqualityFn<T>
): T;
export function useSessionForServer<T>(
  serverId: string | null,
  selector?: SessionSelector<T>,
  equalityFn?: EqualityFn<T>
): SessionData | null | T {
  const baseSelector = useCallback(
    (state: ReturnType<typeof useSessionStore.getState>) =>
      (serverId ? state.sessions[serverId] ?? null : null),
    [serverId]
  );

  if (selector) {
    const derivedSelector = useCallback(
      (state: ReturnType<typeof useSessionStore.getState>) => selector(baseSelector(state)),
      [baseSelector, selector]
    );
    return useStoreWithEqualityFn(useSessionStore, derivedSelector, equalityFn);
  }

  return useSessionStore(baseSelector);
}
