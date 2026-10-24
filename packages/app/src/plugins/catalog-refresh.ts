export interface CatalogCatchUpSignal {
  isVisibleCatchUpPending(): boolean;
  subscribe(listener: () => void): () => void;
}

/** Only snapshots wait; an explicit catalog change cancels the deferred snapshot. */
export function createCatalogRefresh(input: {
  catchUp: CatalogCatchUpSignal | null | undefined;
  refresh(pluginId?: string): void;
  schedule(task: () => void, delayMs: number): () => void;
}) {
  let cancelTimer: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  function cancel() {
    cancelTimer?.();
    unsubscribe?.();
    cancelTimer = undefined;
    unsubscribe = undefined;
  }
  function refresh(pluginId?: string) {
    cancel();
    input.refresh(pluginId);
  }
  return {
    snapshot() {
      if (cancelTimer) return;
      if (!input.catchUp?.isVisibleCatchUpPending()) {
        refresh();
        return;
      }
      unsubscribe = input.catchUp.subscribe(() => {
        if (!input.catchUp?.isVisibleCatchUpPending()) refresh();
      });
      cancelTimer = input.schedule(() => refresh(), 3_000);
    },
    changed: refresh,
    dispose: cancel,
  };
}
