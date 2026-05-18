export type DateBucket = "today" | "yesterday" | "this-week" | "this-month" | "older";

const DATE_BUCKET_LABELS: Record<DateBucket, string> = {
  today: "Today",
  yesterday: "Yesterday",
  "this-week": "Previous 7 Days",
  "this-month": "Previous 30 Days",
  older: "Older",
};

export function getDateBucketLabel(bucket: DateBucket): string {
  return DATE_BUCKET_LABELS[bucket];
}

const DATE_BUCKET_ORDER: DateBucket[] = ["today", "yesterday", "this-week", "this-month", "older"];

export function getDateBucketSortIndex(bucket: DateBucket): number {
  return DATE_BUCKET_ORDER.indexOf(bucket);
}

export function getDateBucket(activityAt: string | null): DateBucket {
  if (!activityAt) return "older";
  const date = new Date(activityAt);
  if (isNaN(date.getTime())) return "older";
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0 && date.toDateString() === now.toDateString()) return "today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "yesterday";
  if (diffDays < 7) return "this-week";
  if (diffDays < 30) return "this-month";
  return "older";
}

export interface DateGroupedItem<T> {
  bucket: DateBucket;
  label: string;
  items: T[];
}

export function groupByDate<T>(
  items: T[],
  getActivityAt: (item: T) => string | null,
): DateGroupedItem<T>[] {
  const groups = new Map<DateBucket, T[]>();

  for (const item of items) {
    const bucket = getDateBucket(getActivityAt(item));
    const existing = groups.get(bucket);
    if (existing) {
      existing.push(item);
    } else {
      groups.set(bucket, [item]);
    }
  }

  return DATE_BUCKET_ORDER.filter((bucket) => groups.has(bucket)).map((bucket) => ({
    bucket,
    label: DATE_BUCKET_LABELS[bucket],
    items: groups.get(bucket)!,
  }));
}
