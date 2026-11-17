import {
  formatCompactTimeUntil,
  nextCompactTimeUntilChange,
  type RelativeTimeResolution,
} from "./time";

/**
 * The shared clock behind relative timestamps.
 *
 * A sidebar row that nothing has happened to should never re-render — that is what the
 * memoization is for — so a "2m" label sitting inside one cannot wait to be re-rendered by
 * something else. It needs its own clock. The naive version of that is one timer per row, which
 * turns a list of fifty workspaces into fifty timers firing at fifty different moments.
 *
 * Instead there is at most one timer per resolution, shared by every subscriber at that
 * resolution, and a tier with no subscribers has no timer at all. A sidebar full of week-old
 * workspaces runs no timers whatsoever, because those labels are `static` and never subscribe.
 */
export type TickResolution = Exclude<RelativeTimeResolution, "static">;

/**
 * How often each tier wakes. The label only changes once per unit, so the interval sets how
 * stale it can be, not how often it moves: an hour-resolution label is at most half an hour
 * behind, which is invisible on a value that reads "3h" for sixty minutes either way.
 */
const INTERVAL_MS: Record<TickResolution, number> = {
  minute: 60_000,
  hour: 30 * 60_000,
  day: 60 * 60_000,
};

interface Tier {
  listeners: Set<() => void>;
  handle: ReturnType<typeof setTimeout> | null;
  interval: ReturnType<typeof setInterval> | null;
}

function createTier(): Tier {
  return { listeners: new Set(), handle: null, interval: null };
}

const tiers: Record<TickResolution, Tier> = {
  minute: createTier(),
  hour: createTier(),
  day: createTier(),
};

function notify(tier: Tier): void {
  // Iterated live rather than copied: a listener that unsubscribes on its own tick — which is
  // exactly what happens when a label ages into a slower tier — deletes from this set mid-loop,
  // and Set iteration is defined under deletion. An entry removed before it is reached is simply
  // not called, which is what unsubscribing asked for.
  for (const listener of tier.listeners) {
    listener();
  }
}

function start(resolution: TickResolution): void {
  const tier = tiers[resolution];
  if (tier.handle !== null || tier.interval !== null) return;

  // Aligned to the wall clock so every row flips together rather than each on the anniversary of
  // whenever it happened to mount.
  const period = INTERVAL_MS[resolution];
  const delay = period - (Date.now() % period);
  tier.handle = setTimeout(() => {
    tier.handle = null;
    notify(tier);
    tier.interval = setInterval(() => notify(tier), period);
  }, delay);
}

function stop(resolution: TickResolution): void {
  const tier = tiers[resolution];
  if (tier.handle !== null) clearTimeout(tier.handle);
  if (tier.interval !== null) clearInterval(tier.interval);
  tier.handle = null;
  tier.interval = null;
}

/** Subscribes to a tier's tick. The tier's timer runs only while it has at least one listener. */
export function subscribeToRelativeTimeTick(
  resolution: TickResolution,
  listener: () => void,
): () => void {
  const tier = tiers[resolution];
  tier.listeners.add(listener);
  if (tier.listeners.size === 1) start(resolution);

  return () => {
    tier.listeners.delete(listener);
    if (tier.listeners.size === 0) stop(resolution);
  };
}

/** `setTimeout` runs longer delays at once; a capped wait just schedules again. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Reports a countdown's label now and each time it changes, until it reads "<1m" for good.
 *
 * A countdown cannot share a tier's tick. It changes when the time left reaches a whole minute,
 * which the target sets, not the wall clock: on the minute tier a wake due at 03:04:00.3 would read
 * "2m" until 03:04:00. So each countdown holds one timer, set for its own next change. Only rows
 * with a pending wake have one.
 */
export function followCompactTimeUntil(date: Date, listener: (label: string) => void): () => void {
  let handle: ReturnType<typeof setTimeout> | null = null;

  function update(): void {
    handle = null;
    const now = new Date();
    listener(formatCompactTimeUntil(date, now));
    const next = nextCompactTimeUntilChange(date, now);
    if (next === null) return;
    handle = setTimeout(update, Math.min(next.getTime() - now.getTime(), MAX_TIMEOUT_MS));
  }

  update();
  return () => {
    if (handle !== null) clearTimeout(handle);
  };
}

/** Test seam: how many tiers currently hold a live timer. */
export function activeRelativeTimeTickerCount(): number {
  return Object.values(tiers).filter((tier) => tier.handle !== null || tier.interval !== null)
    .length;
}
