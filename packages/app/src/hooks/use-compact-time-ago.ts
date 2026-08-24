import { useEffect, useState } from "react";
import { subscribeToRelativeTimeTick, type TickResolution } from "@/utils/relative-time-ticker";
import { describeCompactTimeAgo } from "@/utils/time";

/**
 * A compact relative timestamp that keeps itself current.
 *
 * Call this from the smallest component that renders the text. The state lives there, so a tick
 * re-renders one `<Text>` and nothing above it — the row, the list, and the sidebar are never
 * involved.
 *
 * Two things keep the cost near zero:
 *
 * - **Ticking is not re-rendering.** A tick recomputes the label and only sets state if the
 *   string actually changed. A row reading "3d" is woken hourly and re-renders roughly once a
 *   day, when it becomes "4d".
 * - **The tier follows the label.** As a timestamp ages the label changes more slowly, so the
 *   subscription moves to a slower tier; past a week it unsubscribes for good, because a date
 *   never changes again.
 */
export function useCompactTimeAgo(date: Date | null): string {
  const [label, setLabel] = useState(() => (date ? describeCompactTimeAgo(date).label : ""));

  // Keyed on the instant, not the Date object: the store parses a fresh Date on every payload, so
  // depending on identity would tear down and rebuild the subscription for an unchanged time.
  const time = date === null ? null : date.getTime();

  useEffect(() => {
    if (time === null) {
      setLabel("");
      return undefined;
    }

    const source = new Date(time);
    let current = describeCompactTimeAgo(source);
    setLabel(current.label);

    let unsubscribe: (() => void) | null = null;

    const handleTick = () => {
      const next = describeCompactTimeAgo(source);
      if (next.label !== current.label) {
        setLabel(next.label);
      }
      if (next.resolution !== current.resolution) {
        // Aged into a slower tier — or out of them entirely.
        current = next;
        unsubscribe?.();
        unsubscribe = null;
        attach();
        return;
      }
      current = next;
    };

    const attach = () => {
      if (current.resolution === "static") return;
      unsubscribe = subscribeToRelativeTimeTick(current.resolution as TickResolution, handleTick);
    };

    attach();
    return () => {
      unsubscribe?.();
    };
  }, [time]);

  return label;
}
