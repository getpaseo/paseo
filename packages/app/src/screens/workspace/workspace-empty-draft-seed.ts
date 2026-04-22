export function shouldSeedEmptyWorkspaceDraft(input: {
  isRouteFocused: boolean;
  hasPersistenceKey: boolean;
  hasWorkspaceDirectory: boolean;
  hasHydratedWorkspaceLayoutStore: boolean;
  hasHydratedAgents: boolean;
  hasLoadedTerminals: boolean;
  activeAgentCount: number;
  terminalCount: number;
  tabCount: number;
}): boolean {
  if (
    !input.isRouteFocused ||
    !input.hasPersistenceKey ||
    !input.hasWorkspaceDirectory ||
    !input.hasHydratedWorkspaceLayoutStore ||
    !input.hasHydratedAgents ||
    !input.hasLoadedTerminals
  ) {
    return false;
  }

  return input.activeAgentCount === 0 && input.terminalCount === 0 && input.tabCount === 0;
}
