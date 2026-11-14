import { z } from "zod";
import { displayPercent, resolveUsageSnapshot } from "./model";
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
  /** Report IDs the user arranged, in their order. Shared by every host. */
  cardOrder: string[];
  /** Report IDs the user turned off. Their cards collapse and leave the sidebar summary. */
  cardsOff: string[];
}

export const DEFAULT_USAGE_PREFERENCES: UsagePreferences = {
  displayAs: "used",
  pins: null,
  serverId: null,
  cardOrder: [],
  cardsOff: [],
};

const pinsSchema = z.array(z.object({ sourceId: z.string(), windowId: z.string() }));
const reportIdsSchema = z.array(z.string()).optional().catch(undefined);

export const UsagePreferencesSchema = z
  .object({
    displayAs: z.enum(["used", "remaining"]).catch("used"),
    pins: pinsSchema.nullable().optional().catch(null),
    // COMPAT(usagePinSelection): added in v0.11, remove after 2027-04-02.
    // Old [] meant defaults. Read it only when the new selection is absent.
    pinned: pinsSchema.optional().catch([]),
    serverId: z.string().nullable().catch(null),
    cardOrder: reportIdsSchema,
    cardsOff: reportIdsSchema,
  })
  .transform(({ displayAs, pins, pinned, serverId, cardOrder, cardsOff }): UsagePreferences => {
    const legacyPins = pinned && pinned.length > 0 ? pinned : null;
    return {
      displayAs,
      pins: pins === undefined ? legacyPins : pins,
      serverId,
      cardOrder: cardOrder ?? [],
      cardsOff: cardsOff ?? [],
    };
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
    const snapshot = resolveUsageSnapshot(entry);
    if (!snapshot) continue;
    const withPercent = snapshot.report.windows.filter(
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

/** Reports the user has not arranged: by provider, then account, then ID. */
function compareByDefaultOrder(a: UsageReportEntry, b: UsageReportEntry): number {
  return (
    a.sourceLabel.localeCompare(b.sourceLabel) ||
    (a.account.label ?? "").localeCompare(b.account.label ?? "") ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Reports in the order their cards show: the ones the user arranged first, in their order, then
 * the rest in the default order. Arrival order never matters, so a report that streams in late or
 * appears for a new login lands in its own slot.
 */
export function arrangeUsageReports(
  reports: readonly UsageReportEntry[],
  preferences: UsagePreferences,
): UsageReportEntry[] {
  const rank = new Map(preferences.cardOrder.map((id, index) => [id, index]));
  return [...reports].sort((a, b) => {
    const rankA = rank.get(a.id);
    const rankB = rank.get(b.id);
    if (rankA !== undefined && rankB !== undefined) return rankA - rankB;
    if (rankA !== undefined) return -1;
    if (rankB !== undefined) return 1;
    return compareByDefaultOrder(a, b);
  });
}

/** Reports whose cards are on, in card order: what the sidebar summary reads. */
export function usageReportsOn(
  reports: readonly UsageReportEntry[],
  preferences: UsagePreferences,
): UsageReportEntry[] {
  return arrangeUsageReports(reports, preferences).filter(
    (entry) => !isUsageCardOff(preferences, entry.id),
  );
}

/** A drop as the list reports it: the card the user moved and the shown cards' order after it. */
export interface UsageCardDrop {
  moved: string;
  after: readonly string[];
}

/**
 * The order after the user drops a card. Only the moved card changes place: it goes just before
 * its new successor among the shown cards, or just after its new predecessor when it lands last.
 * Shown cards not yet arranged are added at the end, in their shown order. Other arranged cards
 * keep their places relative to each other. The order is shared by every host, so a drop that
 * arranges a card another host also shows ranks it ahead of that host's unarranged cards.
 */
export function arrangeUsageCards(
  preferences: UsagePreferences,
  { moved, after }: UsageCardDrop,
): UsagePreferences {
  const arranged = new Set([...preferences.cardOrder, moved]);
  const rest = [
    ...preferences.cardOrder.filter((id) => id !== moved),
    ...after.filter((id) => !arranged.has(id)),
  ];
  const index = after.indexOf(moved);
  const successor = after[index + 1];
  const at = successor === undefined ? rest.indexOf(after[index - 1]) + 1 : rest.indexOf(successor);
  rest.splice(at, 0, moved);
  return { ...preferences, cardOrder: rest };
}

export function isUsageCardOff(preferences: UsagePreferences, reportId: string): boolean {
  return preferences.cardsOff.includes(reportId);
}

export function setUsageCardOn(
  preferences: UsagePreferences,
  reportId: string,
  on: boolean,
): UsagePreferences {
  const others = preferences.cardsOff.filter((id) => id !== reportId);
  return { ...preferences, cardsOff: on ? others : [...others, reportId] };
}
