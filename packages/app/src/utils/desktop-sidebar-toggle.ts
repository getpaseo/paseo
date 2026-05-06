interface DesktopSidebarToggleInput {
  isAgentListOpen: boolean;
  isFileExplorerOpen: boolean;
  openAgentList: () => void;
  closeAgentList: () => void;
  closeFileExplorer: () => void;
  toggleFocusedFileExplorer: () => boolean;
}

export function toggleDesktopSidebarsWithCheckoutIntent(input: DesktopSidebarToggleInput): boolean {
  if (input.isAgentListOpen || input.isFileExplorerOpen) {
    input.closeAgentList();
    input.closeFileExplorer();
    return true;
  }

  input.openAgentList();
  input.toggleFocusedFileExplorer();
  return true;
}
