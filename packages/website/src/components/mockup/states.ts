/** The scenes the hero mockup can show, in pill order. Each pill's label is `landing.mockup.<id>`. */
export const MOCKUP_STATES = ["orchestrate", "remote", "review", "ship", "extend"] as const;

export type MockupStateId = (typeof MOCKUP_STATES)[number];

export const DEFAULT_MOCKUP_STATE: MockupStateId = "orchestrate";

/** Which states keep a panel docked to the right of the workspace. */
export function hasRightPanel(_state: MockupStateId): boolean {
  return true;
}
