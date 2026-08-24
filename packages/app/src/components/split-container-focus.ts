import type { SplitNode, SplitPane } from "@/stores/workspace-layout-store";

export function resolveSplitContainerRoot(input: {
  root: SplitNode;
  focusedPaneId: string | null;
  focusModeEnabled: boolean | undefined;
}): { root: SplitNode; usesFallbackStrip: boolean } {
  const isolatedPaneId = input.focusModeEnabled ? input.focusedPaneId : null;
  if (!isolatedPaneId) return { root: input.root, usesFallbackStrip: false };
  const isolatedPane = findPane(input.root, isolatedPaneId);
  if (!isolatedPane || isolatedPane.hidden === true) {
    return { root: input.root, usesFallbackStrip: Boolean(input.focusModeEnabled) };
  }
  return { root: { kind: "pane", pane: isolatedPane }, usesFallbackStrip: false };
}

/** Whether a split subtree contains the pane currently projected full-size. */
export function splitNodeContainsPane(node: SplitNode, paneId: string): boolean {
  if (node.kind === "pane") return node.pane.id === paneId;
  return node.group.children.some((child) => splitNodeContainsPane(child, paneId));
}

function findPane(node: SplitNode, paneId: string): SplitPane | null {
  if (node.kind === "pane") return node.pane.id === paneId ? node.pane : null;
  for (const child of node.group.children) {
    const pane = findPane(child, paneId);
    if (pane) return pane;
  }
  return null;
}
