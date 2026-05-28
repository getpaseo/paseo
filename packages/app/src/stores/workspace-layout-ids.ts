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

export const defaultWorkspaceLayoutIds: WorkspaceLayoutIdSource = {
  createNodeId: (prefix) => `${prefix}_${createRandomIdValue()}`,
  createFocusRestorationToken: () => `workspace-focus-${createRandomIdValue()}`,
};
