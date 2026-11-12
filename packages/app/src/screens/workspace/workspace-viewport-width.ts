import { useCallback, useSyncExternalStore } from "react";

// The workspace viewport changes width on every frame of a left sidebar drag. Holding it in
// WorkspaceScreenContent state re-rendered the whole screen per layout event, and each React
// commit paused Reanimated's UI-thread commits, so the sidebar edge followed the JS thread.
// Only the explorer frame reads this width, and only while it can be seen.
export interface WorkspaceViewportWidthStore {
  get: () => number;
  set: (width: number) => void;
  subscribe: (listener: () => void) => () => void;
}

// A change smaller than one point does not move any explorer allocation.
const PUBLISH_THRESHOLD = 1;

export function createWorkspaceViewportWidthStore(): WorkspaceViewportWidthStore {
  let published = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => published,
    set: (width) => {
      if (width <= 0 || Math.abs(width - published) < PUBLISH_THRESHOLD) return;
      published = width;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function noopUnsubscribe() {}

/**
 * Reads the published width. While `enabled` is false the caller does not re-render for width
 * changes; it picks up the latest published value on its next render.
 */
export function useWorkspaceViewportWidth(
  store: WorkspaceViewportWidthStore,
  enabled: boolean,
): number {
  const subscribe = useCallback(
    (listener: () => void) => (enabled ? store.subscribe(listener) : noopUnsubscribe),
    [enabled, store],
  );
  return useSyncExternalStore(subscribe, store.get, store.get);
}
