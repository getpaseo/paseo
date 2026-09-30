import { z } from "zod";

/** Whether percentages read as the share used or the share left. */
export type UsageDisplayAs = "used" | "remaining";

/** A window the user pinned to the sidebar Usage item. It matches every account of the source. */
export interface UsagePin {
  sourceId: string;
  windowId: string;
}

/** Device-local. `pinned` is in display order. */
export interface UsagePreferences {
  displayAs: UsageDisplayAs;
  pinned: UsagePin[];
}

export const DEFAULT_USAGE_PREFERENCES: UsagePreferences = { displayAs: "used", pinned: [] };

export const UsagePreferencesSchema = z
  .object({
    displayAs: z.enum(["used", "remaining"]).catch("used"),
    pinned: z.array(z.object({ sourceId: z.string(), windowId: z.string() })).catch([]),
  })
  .catch(DEFAULT_USAGE_PREFERENCES);

function samePin(a: UsagePin, b: UsagePin): boolean {
  return a.sourceId === b.sourceId && a.windowId === b.windowId;
}

export function isUsagePinned(preferences: UsagePreferences, pin: UsagePin): boolean {
  return preferences.pinned.some((pinned) => samePin(pinned, pin));
}

/** Unpins a pinned window; pins any other at the end, so the Usage item grows to the right. */
export function toggleUsagePin(preferences: UsagePreferences, pin: UsagePin): UsagePreferences {
  const pinned = isUsagePinned(preferences, pin)
    ? preferences.pinned.filter((existing) => !samePin(existing, pin))
    : [...preferences.pinned, { sourceId: pin.sourceId, windowId: pin.windowId }];
  return { ...preferences, pinned };
}

export function setUsageDisplayAs(
  preferences: UsagePreferences,
  displayAs: UsageDisplayAs,
): UsagePreferences {
  return { ...preferences, displayAs };
}
