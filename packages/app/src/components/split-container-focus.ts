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

/** Whether a workspace pane has another visible pane it can be maximized over. */
export function hasMultipleVisiblePanes(node: SplitNode): boolean {
  let visiblePaneCount = 0;
  const visit = (current: SplitNode): void => {
    if (current.kind === "pane") {
      if (current.pane.hidden !== true) visiblePaneCount += 1;
      return;
    }
    for (const child of current.group.children) {
      visit(child);
      if (visiblePaneCount > 1) return;
    }
  };
  visit(node);
  return visiblePaneCount > 1;
}

function findPane(node: SplitNode, paneId: string): SplitPane | null {
  if (node.kind === "pane") return node.pane.id === paneId ? node.pane : null;
  for (const child of node.group.children) {
    const pane = findPane(child, paneId);
    if (pane) return pane;
  }
  return null;
}
