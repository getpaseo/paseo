import { z } from "zod";
import { displayPercent } from "./model";
import type { UsageReportEntry } from "./types";

/** Whether percentages read as the share used or the share left. */
export type UsageDisplayAs = "used" | "remaining";

/** A window the user pinned to the sidebar Usage item. It matches every account of the source. */
export interface UsagePin {
  sourceId: string;
  windowId: string;
}

/** Device-local. `pins` is in selection order. */
export interface UsagePreferences {
  displayAs: UsageDisplayAs;
  /** null follows source defaults; an array is the user's selection, including none. */
  pins: UsagePin[] | null;
  /** The host the user picked to show usage for; null until they pick one. */
  serverId: string | null;
}

export const DEFAULT_USAGE_PREFERENCES: UsagePreferences = {
  displayAs: "used",
  pins: null,
  serverId: null,
};

const pinsSchema = z.array(z.object({ sourceId: z.string(), windowId: z.string() }));

export const UsagePreferencesSchema = z
  .object({
    displayAs: z.enum(["used", "remaining"]).catch("used"),
    pins: pinsSchema.nullable().optional().catch(null),
    // COMPAT(usagePinSelection): added in v0.11, remove after 2027-04-02.
    // Old [] meant defaults. Read it only when the new selection is absent.
    pinned: pinsSchema.optional().catch([]),
    serverId: z.string().nullable().catch(null),
  })
  .transform(({ displayAs, pins, pinned, serverId }): UsagePreferences => {
    const legacyPins = pinned && pinned.length > 0 ? pinned : null;
    return { displayAs, pins: pins === undefined ? legacyPins : pins, serverId };
  })
  .catch(DEFAULT_USAGE_PREFERENCES);

function samePin(a: UsagePin, b: UsagePin): boolean {
  return a.sourceId === b.sourceId && a.windowId === b.windowId;
}

/** The only owner of default and customized pin selection, shared by every usage surface. */
export function effectiveUsagePins(
  preferences: UsagePreferences,
  reports: readonly UsageReportEntry[],
): UsagePin[] {
  if (preferences.pins !== null) return preferences.pins;
  const pins: UsagePin[] = [];
  for (const entry of reports) {
    if (entry.report.status !== "available") continue;
    const withPercent = entry.report.windows.filter(
      (window) => displayPercent(window, preferences.displayAs) !== null,
    );
    const marked = withPercent.filter((window) => window.summary);
    for (const window of marked.length > 0 ? marked : withPercent.slice(0, 1)) {
      const pin = { sourceId: entry.sourceId, windowId: window.id };
      if (!pins.some((existing) => samePin(existing, pin))) pins.push(pin);
    }
  }
  return pins;
}

export function isUsagePinned(
  preferences: UsagePreferences,
  pin: UsagePin,
  reports: readonly UsageReportEntry[],
): boolean {
  return effectiveUsagePins(preferences, reports).some((pinned) => samePin(pinned, pin));
}

/** The first edit snapshots the displayed defaults before toggling one window. */
export function toggleUsagePin({
  preferences,
  pin,
  reports,
}: {
  preferences: UsagePreferences;
  pin: UsagePin;
  reports: readonly UsageReportEntry[];
}): UsagePreferences {
  const selected = effectiveUsagePins(preferences, reports);
  const pins = selected.some((existing) => samePin(existing, pin))
    ? selected.filter((existing) => !samePin(existing, pin))
    : [...selected, { sourceId: pin.sourceId, windowId: pin.windowId }];
  return { ...preferences, pins };
}

export function setUsageDisplayAs(
  preferences: UsagePreferences,
  displayAs: UsageDisplayAs,
): UsagePreferences {
  return { ...preferences, displayAs };
}

export function setUsageHost(preferences: UsagePreferences, serverId: string): UsagePreferences {
  return { ...preferences, serverId };
}
