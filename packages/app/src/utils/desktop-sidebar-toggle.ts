interface DesktopSidebarToggleInput {
  isAgentListOpen: boolean;
  isExplorerOpen: boolean;
  openAgentList: () => void;
  closeAgentList: () => void;
  toggleExplorer: () => void;
}

/**
 * "Toggle both sidebars" collapses the workspace to just its content when
 * anything is showing, and restores both when nothing is. The explorer only
 * exposes a toggle, so each side is nudged only when it is on the wrong side
 * of the intent.
 */
export function toggleDesktopSidebarsWithCheckoutIntent(input: DesktopSidebarToggleInput): boolean {
  const shouldOpen = !input.isAgentListOpen && !input.isExplorerOpen;

  if (input.isAgentListOpen !== shouldOpen) {
    if (shouldOpen) {
      input.openAgentList();
    } else {
      input.closeAgentList();
    }
  }
  if (input.isExplorerOpen !== shouldOpen) {
    input.toggleExplorer();
  }
  return true;
}
