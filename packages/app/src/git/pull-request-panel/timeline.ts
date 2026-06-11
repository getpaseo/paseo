import type { PrPaneActivity } from "./data";

export type PrThreadLocation = NonNullable<PrPaneActivity["location"]>;

export type PrTimelineEntry =
  | { kind: "single"; id: string; activity: PrPaneActivity }
  | {
      kind: "thread";
      id: string;
      location: PrThreadLocation;
      comments: PrPaneActivity[];
    };

/**
 * Groups review-thread comments (same `location.threadId`) into a single
 * thread entry so replies render nested under the root comment, GitHub-style.
 * The thread sits at the position of its first comment; everything else stays
 * a standalone entry in original order.
 */
export function buildPrTimeline(activities: readonly PrPaneActivity[]): PrTimelineEntry[] {
  const entries: PrTimelineEntry[] = [];
  const threadsById = new Map<string, Extract<PrTimelineEntry, { kind: "thread" }>>();

  for (const activity of activities) {
    const threadId = activity.location?.threadId;
    if (!activity.location || !threadId) {
      entries.push({ kind: "single", id: activity.id, activity });
      continue;
    }

    const existing = threadsById.get(threadId);
    if (existing) {
      existing.comments.push(activity);
      continue;
    }

    const thread: Extract<PrTimelineEntry, { kind: "thread" }> = {
      kind: "thread",
      id: `thread:${threadId}`,
      location: activity.location,
      comments: [activity],
    };
    threadsById.set(threadId, thread);
    entries.push(thread);
  }

  return entries;
}
