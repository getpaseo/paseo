export type RouteHistoryDirection = "back" | "forward";

// Native does not activate the keyboard shortcut dispatcher or show shortcut
// settings. Keep the platform fallback inert if that contract changes.
export function navigateRouteHistory(_direction: RouteHistoryDirection): boolean {
  return false;
}
