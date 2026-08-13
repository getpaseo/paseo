/**
 * How much of a workspace's CI a sidebar row spends space on.
 *
 * Not one of the boolean row items, because the icon on its own is a real third answer rather
 * than half of "off": the state stays on the row for a glance, and a passing workspace stops
 * paying a word for it on every line. A boolean cannot say that, and widening the row-items
 * record to hold it would make three settings carry a shape only one of them uses.
 *
 * Pure on purpose, like `row-items.ts`: `hooks/use-settings/storage.ts` validates the persisted
 * value through `parseSidebarChecksDisplay` rather than growing its own copy of the value list.
 */

export const SIDEBAR_CHECKS_DISPLAYS = ["iconAndText", "icon", "none"] as const;

export type SidebarChecksDisplay = (typeof SIDEBAR_CHECKS_DISPLAYS)[number];

export const DEFAULT_SIDEBAR_CHECKS_DISPLAY: SidebarChecksDisplay = "iconAndText";

/** Null for anything that isn't one of the three, so callers can tell "absent" from "chosen". */
export function parseSidebarChecksDisplay(value: unknown): SidebarChecksDisplay | null {
  if (typeof value !== "string") {
    return null;
  }
  return (SIDEBAR_CHECKS_DISPLAYS as readonly string[]).includes(value)
    ? (value as SidebarChecksDisplay)
    : null;
}
