interface SessionsSource<TSession> {
  sessions: Record<string, TSession | undefined>;
}

/**
 * Wraps a whole-store selector so it reruns only when one of the per-session maps it reads has
 * changed. `pickMaps` returns every map the selector reads from one session. Session-store writes that leave those maps alone (timeline updates, drafts) then cost
 * a reference check per host instead of a walk over every entry.
 */
export function memoizeOnSessionMaps<TSession, TState extends SessionsSource<TSession>, TResult>(
  pickMaps: (session: TSession) => readonly unknown[],
  derive: (state: TState) => TResult,
): (state: TState) => TResult {
  let previousMaps: unknown[] | null = null;
  let previousResult: TResult;
  return (state) => {
    const maps = Object.values(state.sessions).flatMap((session) =>
      session ? pickMaps(session) : [undefined],
    );
    if (
      previousMaps &&
      previousMaps.length === maps.length &&
      previousMaps.every((map, index) => map === maps[index])
    ) {
      return previousResult;
    }
    previousMaps = maps;
    previousResult = derive(state);
    return previousResult;
  };
}
