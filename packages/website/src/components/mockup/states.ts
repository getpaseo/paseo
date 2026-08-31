/**
 * The states the hero mockup can be in, in pill order. Labels are copy — edit
 * them here and nothing else has to change.
 */
export const MOCKUP_STATES = [
  { id: "build", label: "Build" },
  { id: "review", label: "Review" },
  { id: "ship", label: "Ship" },
  { id: "extend", label: "Extend" },
] as const;

export type MockupStateId = (typeof MOCKUP_STATES)[number]["id"];

export const DEFAULT_MOCKUP_STATE: MockupStateId = "build";

/** Which states keep a panel docked to the right of the workspace. */
export function hasRightPanel(_state: MockupStateId): boolean {
  return true;
}
