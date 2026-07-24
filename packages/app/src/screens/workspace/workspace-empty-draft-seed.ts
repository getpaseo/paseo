export function isEmptyWorkspaceLayoutReady(input: {
  isRouteFocused: boolean;
  hasPersistenceKey: boolean;
  hasWorkspaceDirectory: boolean;
  hasHydratedWorkspaceLayoutStore: boolean;
  hasHydratedAgents: boolean;
  hasLoadedTerminals: boolean;
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

  return input.terminalCount === 0 && input.tabCount === 0;
}

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
  return isEmptyWorkspaceLayoutReady(input) && input.activeAgentCount === 0;
}

export function selectRediscoverableHiddenAgentIds(input: {
  hiddenAgentIds: ReadonlySet<string>;
  autoOpenAgentIds: ReadonlySet<string>;
  activeAgentIds: ReadonlySet<string>;
}): string[] {
  const rediscoverable: string[] = [];
  for (const agentId of input.hiddenAgentIds) {
    if (input.autoOpenAgentIds.has(agentId) && input.activeAgentIds.has(agentId)) {
      rediscoverable.push(agentId);
    }
  }
  return rediscoverable.sort();
}

export type EmptyWorkspaceRecovery =
  | { kind: "noop" }
  | { kind: "reopen-hidden-agents"; agentIds: string[] }
  | { kind: "seed-draft" };

export function decideEmptyWorkspaceRecovery(input: {
  layoutReady: boolean;
  rediscoverableHiddenAgentIds: readonly string[];
  activeAgentCount: number;
}): EmptyWorkspaceRecovery {
  if (!input.layoutReady) {
    return { kind: "noop" };
  }
  if (input.rediscoverableHiddenAgentIds.length > 0) {
    return {
      kind: "reopen-hidden-agents",
      agentIds: [...input.rediscoverableHiddenAgentIds],
    };
  }
  if (input.activeAgentCount === 0) {
    return { kind: "seed-draft" };
  }
  return { kind: "noop" };
}
