export interface RouteLeaveGuard {
  isDirty: () => boolean;
  confirmDiscard: () => Promise<boolean>;
}

/**
 * Installs the web browser history (`popstate`) guard before Expo Router mounts
 * its own `popstate` listener. No-op on native, where React Navigation's
 * `beforeRemove` owns swipe-back and hardware Back interception.
 */
export function installRouteLeavePopStateGuard(): void {
  // Native platforms handle back navigation through React Navigation's beforeRemove event.
}

/** Registers the active screen's leave guard for browser Back/Forward interception. */
export function registerRouteLeaveGuard(_guard: RouteLeaveGuard | null): () => void {
  return () => {};
}
