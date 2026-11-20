import { useEffect, useState } from "react";
import { subscribeToRelativeTimeTick } from "@/utils/relative-time-ticker";

/** The current time as a render input, updated while a relative-time label is mounted. */
export function useRelativeTimeTick({ enabled }: { enabled: boolean }): number {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!enabled) return undefined;
    return subscribeToRelativeTimeTick("minute", () => setNow(Date.now()));
  }, [enabled]);
  return now;
}
