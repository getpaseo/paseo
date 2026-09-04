export type RouteHistoryDirection = "back" | "forward";

export function navigateRouteHistory(direction: RouteHistoryDirection): boolean {
  if (direction === "back") {
    window.history.back();
  } else {
    window.history.forward();
  }
  return true;
}
