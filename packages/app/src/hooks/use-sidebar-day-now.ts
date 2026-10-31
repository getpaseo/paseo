import { useEffect, useState } from "react";
import { useAppVisible } from "@/hooks/use-app-visible";

/** Refreshes day boundaries at local midnight and when a suspended app returns to the foreground. */
export function useSidebarDayNow(enabled: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  const visible = useAppVisible();
  useEffect(() => {
    if (!enabled || !visible) return;
    // Native timers may be suspended overnight. Recheck on foreground return on every platform.
    setNow(new Date());
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const currentTime = new Date();
      const nextMidnight = new Date(currentTime);
      nextMidnight.setHours(24, 0, 0, 0);
      timer = setTimeout(
        () => {
          setNow(new Date());
          schedule();
        },
        nextMidnight.getTime() - currentTime.getTime() + 1000,
      );
    };
    schedule();
    return () => clearTimeout(timer);
  }, [enabled, visible]);
  return now;
}
