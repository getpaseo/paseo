import { useEffect } from "react";
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
  const navigate = useApplicationRouteHistory(readHref);

  useEffect(() => {
    if (!isWeb) return;
    const handleMouseButton = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      // Cancel browser navigation, including at the ends of app history. Handle
      // only release so the press/release/auxclick sequence moves exactly once.
      event.preventDefault();
      event.stopPropagation();
      if (event.type === "mouseup") {
        navigate(event.button === 3 ? "back" : "forward");
      }
    };
    window.addEventListener("mousedown", handleMouseButton, true);
    window.addEventListener("mouseup", handleMouseButton, true);
    window.addEventListener("auxclick", handleMouseButton, true);
    return () => {
      window.removeEventListener("mousedown", handleMouseButton, true);
      window.removeEventListener("mouseup", handleMouseButton, true);
      window.removeEventListener("auxclick", handleMouseButton, true);
    };
  }, [navigate]);

  return navigate;
}
