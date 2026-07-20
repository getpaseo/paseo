import { useCallback, useSyncExternalStore } from "react";
import { paneFindController } from "./pane-find-controller";
import type { PaneFindAdapter, PaneFindState } from "./pane-find-types";

/** The currently focused pane's adapter, or null when no pane is focused. */
export function useActivePaneFindAdapter(): PaneFindAdapter | null {
  return useSyncExternalStore(
    paneFindController.subscribe,
    paneFindController.getActiveAdapter,
    paneFindController.getActiveAdapter,
  );
}

/** Increments whenever Ctrl/Cmd+F requests focus for the active pane's find UI. */
export function usePaneFindFocusRequestRevision(): number {
  return useSyncExternalStore(
    paneFindController.subscribe,
    paneFindController.getFocusRequestRevision,
    paneFindController.getFocusRequestRevision,
  );
}

/** Live state of a given adapter (or null when there is no adapter). */
export function usePaneFindAdapterState(adapter: PaneFindAdapter | null): PaneFindState | null {
  const subscribe = useCallback(
    (listener: () => void) => (adapter ? adapter.subscribe(listener) : () => {}),
    [adapter],
  );
  const getSnapshot = useCallback(() => adapter?.getState() ?? null, [adapter]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
