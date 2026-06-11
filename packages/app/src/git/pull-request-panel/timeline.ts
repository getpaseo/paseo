import type { PrPaneActivity } from "./data";

export type PrThreadLocation = NonNullable<PrPaneActivity["location"]>;

export interface PrThreadEntry {
  kind: "thread";
  id: string;
  location: PrThreadLocation;
  comments: PrPaneActivity[];
}

export interface PrReviewEntry {
  kind: "review";
  id: string;
  review: PrPaneActivity;
  threads: PrThreadEntry[];
}

export type PrTimelineEntry =
  | { kind: "single"; id: string; activity: PrPaneActivity }
  | PrThreadEntry
  | PrReviewEntry;

/**
 * Builds the GitHub-style nested timeline:
 * - comments sharing a `location.threadId` collapse into one thread entry
 *   (root comment + replies), placed at the first comment's position;
 * - threads whose root comment carries a `reviewId` nest under that review
 *   (GitHub's explicit signal: PullRequestReviewComment.pullRequestReview);
 * - everything else stays a standalone entry in original order.
 */
export function buildPrTimeline(activities: readonly PrPaneActivity[]): PrTimelineEntry[] {
  const entries = groupThreads(activities);
  return nestThreadsUnderReviews(entries);
}

function groupThreads(activities: readonly PrPaneActivity[]): PrTimelineEntry[] {
  const entries: PrTimelineEntry[] = [];
  const threadsById = new Map<string, PrThreadEntry>();

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

    const thread: PrThreadEntry = {
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

function nestThreadsUnderReviews(entries: PrTimelineEntry[]): PrTimelineEntry[] {
  const reviewIds = new Set(
    entries.flatMap((entry) =>
      entry.kind === "single" && entry.activity.kind === "review" ? [entry.activity.id] : [],
    ),
  );
  const threadsByReviewId = new Map<string, PrThreadEntry[]>();

  for (const entry of entries) {
    if (entry.kind !== "thread") {
      continue;
    }
    const reviewId = entry.comments[0]?.reviewId;
    if (!reviewId || !reviewIds.has(reviewId)) {
      continue;
    }
    const threads = threadsByReviewId.get(reviewId) ?? [];
    threads.push(entry);
    threadsByReviewId.set(reviewId, threads);
  }

  if (threadsByReviewId.size === 0) {
    return entries;
  }

  const nestedThreads = new Set([...threadsByReviewId.values()].flat());
  return entries.flatMap((entry): PrTimelineEntry[] => {
    if (entry.kind === "thread") {
      return nestedThreads.has(entry) ? [] : [entry];
    }
    if (entry.kind === "single" && entry.activity.kind === "review") {
      const threads = threadsByReviewId.get(entry.activity.id);
      if (threads) {
        return [{ kind: "review" as const, id: entry.id, review: entry.activity, threads }];
      }
    }
    return [entry];
  });
}
