/**
 * A keyboard handler id is an identity, not a label.
 *
 * The dispatcher keeps one live handler per id and useKeyboardActionHandler
 * registers once per id, never re-registering when focus changes. So when two
 * mounted surfaces produce the same id, the second one evicts the first and the
 * first is left without a keyboard for the rest of its mount — silently, with no
 * symptom until someone presses the key.
 *
 * The workspace deck keeps several workspaces mounted at once, so a workspace
 * surface is only identified by its server, its workspace, and its pane. Pane
 * ids are namespaced per workspace ("main" is every workspace's default pane),
 * which is why they cannot carry the identity on their own.
 */
export interface WorkspaceKeyboardSurface {
  /** Stable name for the surface, e.g. "workspace-new-tab-menu". */
  name: string;
  serverId: string;
  workspaceId: string;
  /** Omit for surfaces that own the whole workspace rather than one pane. */
  paneId?: string | null;
}

export function buildWorkspaceKeyboardHandlerId({
  name,
  serverId,
  workspaceId,
  paneId,
}: WorkspaceKeyboardSurface): string {
  const trimmedPaneId = paneId?.trim();
  const paneSegment = trimmedPaneId ? `:${trimmedPaneId}` : "";
  return `${name}:${serverId}:${workspaceId}${paneSegment}`;
}
