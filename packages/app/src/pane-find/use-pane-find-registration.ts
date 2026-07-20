import { useEffect } from "react";
import { paneFindController } from "./pane-find-controller";
import { registerPaneFindAdapter } from "./pane-find-helpers";
import type { PaneFindAdapter } from "./pane-find-types";

export interface UsePaneFindRegistrationInput {
  /**
   * Stable identity for the pane slot — use `usePaneFindKey()` so it matches the
   * key the central find-focus authority (`WorkspacePaneContent`) marks as
   * focused. Null (outside a PaneProvider) skips registration.
   */
  paneKey: string | null;
  adapter: PaneFindAdapter;
}

/**
 * Registers a pane's `PaneFindAdapter` with the shared pane-find registry for
 * as long as the pane is mounted. Focus ownership (which pane `workspace.find.open`
 * routes to) is NOT set here — it is owned centrally by `WorkspacePaneContent`,
 * keyed by the same `paneInstanceId`, so exactly one pane (the focused one) owns
 * Ctrl/Cmd+F regardless of per-pane rendering quirks.
 */
export function usePaneFindRegistration(input: UsePaneFindRegistrationInput): void {
  const { paneKey, adapter } = input;

  useEffect(() => {
    return registerPaneFindAdapter({ controller: paneFindController, paneKey, adapter });
  }, [paneKey, adapter]);
}
