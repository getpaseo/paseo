import { useEffect, useReducer } from "react";
import { subscribeToRelativeTimeTick } from "@/utils/relative-time-ticker";

/** Re-renders a mounted provider-usage label when its relative time can change. */
export function useRelativeTimeTick(enabled: boolean): void {
  const [, tick] = useReducer((value: number) => value + 1, 0);

  useEffect(() => {
    if (!enabled) return undefined;
    return subscribeToRelativeTimeTick("minute", tick);
  }, [enabled]);
}
