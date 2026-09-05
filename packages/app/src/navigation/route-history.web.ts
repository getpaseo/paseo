import { isWeb } from "@/constants/platform";
import { useApplicationRouteHistory } from "./route-history-shared";
export type { RouteHistoryDirection } from "./route-history-state";

function readHref(): string {
  // Expo's global href can contain inherited params absent from the displayed URL.
  return isWeb
    ? `${window.location.pathname}${window.location.search}${window.location.hash}`
    : "/";
}

export function useRouteHistory() {
  return useApplicationRouteHistory(readHref);
}
