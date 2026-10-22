import type { FilePanelOpenWithState } from "./model";

/** Up to this many panels sit side by side in the bar; more go behind a menu. */
const SEGMENTED_PANEL_LIMIT = { wide: 3, compact: 2 };

export interface FilePanelSwitcherState<Candidate> {
  layout: "segmented" | "menu";
  candidates: readonly Candidate[];
  activePanelId: string;
}

/** The bar's panel switcher for a tab's choice; null when the file has one panel or none. */
export function filePanelSwitcherState<Candidate>(
  openWith: FilePanelOpenWithState<Candidate> | null,
  { compact }: { compact: boolean },
): FilePanelSwitcherState<Candidate> | null {
  if (!openWith) return null;
  const limit = compact ? SEGMENTED_PANEL_LIMIT.compact : SEGMENTED_PANEL_LIMIT.wide;
  return {
    layout: openWith.candidates.length > limit ? "menu" : "segmented",
    candidates: openWith.candidates,
    activePanelId: openWith.activePanelId,
  };
}
