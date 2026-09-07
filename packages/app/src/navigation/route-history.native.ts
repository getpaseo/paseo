import type { RouteHistoryDirection } from "./route-history-state";
export type { RouteHistoryDirection } from "./route-history-state";

// Native does not activate the keyboard shortcut dispatcher or show shortcut
// settings. Keep the platform fallback inert if that contract changes.
function navigateRouteHistory(_direction: RouteHistoryDirection): boolean {
  return false;
}

export function useRouteHistory(): (direction: RouteHistoryDirection) => boolean {
  return navigateRouteHistory;
}
