export function toggleSidebarWorkspaceSelection(
  selectedWorkspaceKeys: ReadonlySet<string>,
  workspaceKey: string,
): Set<string> {
  const next = new Set(selectedWorkspaceKeys);
  if (next.has(workspaceKey)) next.delete(workspaceKey);
  else next.add(workspaceKey);
  return next;
}

export function retainVisibleSidebarWorkspaceSelection(
  selectedWorkspaceKeys: ReadonlySet<string>,
  visibleWorkspaceKeys: ReadonlySet<string>,
): Set<string> {
  return new Set(
    [...selectedWorkspaceKeys].filter((workspaceKey) => visibleWorkspaceKeys.has(workspaceKey)),
  );
}

export function shouldToggleSidebarWorkspacePin(input: {
  selectionMode: boolean;
  isElectron: boolean;
  shiftKey: boolean;
  canPin: boolean;
}): boolean {
  return !input.selectionMode && input.isElectron && input.shiftKey && input.canPin;
}
