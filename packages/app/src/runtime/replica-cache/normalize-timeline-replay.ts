import type { CachedTimeline } from "./index";

/** Repair exact cached assistant replays, preserving owner rows and distinct source messages. */
export function normalizeTimelineReplay(value: CachedTimeline | undefined): CachedTimeline | undefined {
  if (!value) return value;
  const seen = new Set<string>();
  let changed = false;
  const items = value.items.filter((item) => {
    const cursor = item.timelineCursor;
    if (item.kind !== "assistant_message" || !cursor) return true;
    const key = JSON.stringify([item.id, item.messageId ?? null, cursor.epoch, cursor.seq, item.text]);
    if (seen.has(key)) {
      changed = true;
      return false;
    }
    seen.add(key);
    return true;
  });
  return changed ? { ...value, items } : value;
}
