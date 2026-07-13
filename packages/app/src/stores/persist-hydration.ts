export interface PersistHydrationApi<TState> {
  hasHydrated: () => boolean;
  onFinishHydration: (listener: (state: TState) => void) => () => void;
}

// Subscribe before checking the current state so hydration cannot finish in the gap between a
// render-time read and effect setup. `notify` is idempotent because completion may race the check.
export function subscribeToPersistHydration<TState>(
  api: PersistHydrationApi<TState>,
  onHydrated: () => void,
): () => void {
  let active = true;
  let notified = false;
  const notify = () => {
    if (!active || notified) return;
    notified = true;
    onHydrated();
  };
  const unsubscribe = api.onFinishHydration(notify);
  if (api.hasHydrated()) notify();
  return () => {
    active = false;
    unsubscribe();
  };
}
