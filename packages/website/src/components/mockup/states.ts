/**
 * The states the hero mockup can be in, in pill order. Labels are copy — edit
 * them here and nothing else has to change.
 */
/** The scenes the hero mockup can show; each pill's label is `landing.mockup.<id>`. */
export const MOCKUP_STATES = ["build", "review", "ship", "extend"] as const;

export type MockupStateId = (typeof MOCKUP_STATES)[number];

export const DEFAULT_MOCKUP_STATE: MockupStateId = "build";

/** Which states keep a panel docked to the right of the workspace. */
export function hasRightPanel(_state: MockupStateId): boolean {
  return true;
}
