export function acceptsWorkspaceTabDrop(
  allowCrossPane: boolean,
  sourcePaneId: string,
  destination: { kind: "workspace-tab" | "split-pane-drop"; paneId: string },
): boolean {
  return (
    allowCrossPane || (destination.kind === "workspace-tab" && sourcePaneId === destination.paneId)
  );
}
