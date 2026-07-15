import type { SplitNode, SplitPane } from "@/stores/workspace-layout-store";

export function resolveSplitContainerRoot(input: {
  root: SplitNode;
  focusedPaneId: string | null;
  focusModeEnabled: boolean | undefined;
}): { root: SplitNode; usesFallbackStrip: boolean } {
  if (!input.focusModeEnabled) return { root: input.root, usesFallbackStrip: false };
  const focusedPane = input.focusedPaneId ? findPane(input.root, input.focusedPaneId) : null;
  if (!focusedPane) return { root: input.root, usesFallbackStrip: true };
  return { root: { kind: "pane", pane: focusedPane }, usesFallbackStrip: false };
}

function findPane(node: SplitNode, paneId: string): SplitPane | null {
  if (node.kind === "pane") return node.pane.id === paneId ? node.pane : null;
  for (const child of node.group.children) {
    const pane = findPane(child, paneId);
    if (pane) return pane;
  }
  return null;
}
