export type WorkspaceLayoutNodeIdPrefix = "pane" | "group";

export interface WorkspaceLayoutIdSource {
  createNodeId: (prefix: WorkspaceLayoutNodeIdPrefix) => string;
  createFocusRestorationToken: () => string;
}

function createRandomIdValue(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createWorkspaceTabInstanceId(): string {
  return `tab_${createRandomIdValue()}`;
}

/** A resource-derived id may still belong to a preview slot showing another target. */
export function allocateWorkspaceTabId(
  preferredId: string,
  occupiedIds: ReadonlySet<string>,
): string {
  let tabId = preferredId;
  for (let suffix = 2; occupiedIds.has(tabId); suffix += 1) {
    tabId = `${preferredId}:${suffix}`;
  }
  return tabId;
}

export const defaultWorkspaceLayoutIds: WorkspaceLayoutIdSource = {
  createNodeId: (prefix) => `${prefix}_${createRandomIdValue()}`,
  createFocusRestorationToken: () => `workspace-focus-${createRandomIdValue()}`,
};
